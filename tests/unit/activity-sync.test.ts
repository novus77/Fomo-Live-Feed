import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TradeEventV1 } from '../../src/domain/activity';
import {
  ActivitySync,
  DEFAULT_MAX_RECOVERY_GAP_MS,
  MAX_RECOVERY_PAGES,
  type ActivitySyncDependencies,
} from '../../src/background/activity-sync';
import {
  normalizeHistoryPage,
  type HistoryClient,
  type HistoryFetchResult,
} from '../../src/fomo/history-client';
import { parseHistoryPage } from '../../src/fomo/history-contract';
import { FomoFeedDatabase } from '../../src/storage/database';
import { EventRepository } from '../../src/storage/event-repository';

const NOW = Date.parse('2026-08-20T08:00:00.000Z');
const FIXTURE_PATH = 'tests/fixtures/fomo-history-page.redacted.json';

const openDatabases: FomoFeedDatabase[] = [];

const createRepository = () => {
  const database = new FomoFeedDatabase(`sync-test-${crypto.randomUUID()}`);
  openDatabases.push(database);

  return new EventRepository(database);
};

afterEach(async () => {
  await Promise.all(
    openDatabases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

const makeEvent = (
  overrides: Partial<TradeEventV1> & Pick<TradeEventV1, 'id' | 'occurredAt'>,
): TradeEventV1 => ({
  schemaVersion: 1,
  id: overrides.id,
  source: 'fomo',
  traderId: overrides.traderId ?? 'trader-a',
  traderHandle: overrides.traderHandle ?? 'alpha',
  chain: overrides.chain ?? 'unknown',
  tokenAddress: overrides.tokenAddress ?? '0x0000000000000000000000000000000000000000',
  tokenSymbol: overrides.tokenSymbol ?? 'AAA',
  action: overrides.action ?? 'buy',
  occurredAt: overrides.occurredAt,
  receivedAt: overrides.receivedAt ?? NOW,
});

// Builds a success page WITHOUT an explicit undefined nextCursor so the
// literal satisfies exactOptionalPropertyTypes (nextCursor is absent, not
// undefined).
const okPage = (events: TradeEventV1[], nextCursor?: string): HistoryFetchResult => ({
  ok: true,
  events,
  ...(nextCursor !== undefined ? { nextCursor } : {}),
});

const fixtureEvents = async (): Promise<TradeEventV1[]> => {
  const page = parseHistoryPage(
    JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as unknown,
  );

  if (page === undefined) {
    throw new Error('fixture must parse');
  }

  return normalizeHistoryPage(page, NOW);
};

interface MockHistory {
  client: HistoryClient;
  calls: Array<{ cursor: string | undefined; limit: number }>;
}

const createHistoryClient = (pages: readonly HistoryFetchResult[]): MockHistory => {
  const calls: Array<{ cursor: string | undefined; limit: number }> = [];
  let index = 0;

  return {
    client: {
      async fetchHistory(options) {
        calls.push({ cursor: options.cursor, limit: options.limit });

        const page = pages[index];
        index += 1;

        return page ?? okPage([]);
      },
    },
    calls,
  };
};

const createSync = (
  repository: EventRepository,
  history: HistoryClient,
  extras: Partial<Pick<ActivitySyncDependencies, 'broadcast' | 'health' | 'now'>> & {
    options?: ConstructorParameters<typeof ActivitySync>[1];
  } = {},
) => {
  const broadcast = extras.broadcast ?? vi.fn();
  const health = extras.health ?? { record: vi.fn() };
  const sync = new ActivitySync(
    {
      events: {
        insert: (event) => repository.insert(event),
        page: (query) => repository.page(query),
      },
      history,
      broadcast,
      health,
      now: extras.now ?? (() => NOW),
    },
    extras.options,
  );

  return { sync, broadcast, health };
};

describe('ActivitySync state model (plan Task 5 Step 5)', () => {
  it('starts idle and transitions through syncing to current/updated', async () => {
    const repository = createRepository();
    let resolveFetch!: (result: HistoryFetchResult) => void;
    const fetchHistory = vi
      .fn<HistoryClient['fetchHistory']>()
      .mockImplementation(
        () =>
          new Promise<HistoryFetchResult>((resolve) => {
            resolveFetch = resolve;
          }),
      );

    const { sync } = createSync(repository, { fetchHistory });

    expect(sync.status()).toEqual({ status: 'idle' });

    const run = sync.sync({ reason: 'manual' });

    expect(sync.status()).toEqual({ status: 'syncing', reason: 'manual', startedAt: NOW });

    resolveFetch(okPage([]));
    await run;

    // Nothing new was inserted -> current.
    expect(sync.status()).toEqual({ status: 'current', finishedAt: NOW });
  });

  it('reports updated with the added count after a run inserted events', async () => {
    const repository = createRepository();
    const events = await fixtureEvents();
    const { client } = createHistoryClient([okPage(events)]);
    const { sync } = createSync(repository, client);

    await sync.sync({ reason: 'reconnect' });

    expect(sync.status()).toEqual({ status: 'updated', added: 4, finishedAt: NOW });
  });

  it('fires onStateChange on every state transition', async () => {
    const repository = createRepository();
    const onStateChange = vi.fn();
    const { client } = createHistoryClient([okPage([])]);
    const { sync } = createSync(repository, client, { options: { onStateChange } });

    await sync.sync({ reason: 'stale-panel-open' });

    // idle -> syncing -> current.
    expect(onStateChange).toHaveBeenCalledTimes(2);
  });

  it('maps a disabled history client to recovery-unavailable', async () => {
    const repository = createRepository();
    const history: HistoryClient = {
      async fetchHistory() {
        return { ok: false, reason: 'unavailable' };
      },
    };
    const { sync, health } = createSync(repository, history);

    const result = await sync.sync({ reason: 'manual' });

    expect(result).toEqual({ status: 'failed', reason: 'unavailable' });
    expect(sync.status()).toEqual({ status: 'recovery-unavailable' });
    expect(health.record).not.toHaveBeenCalled();
  });

  it.each([
    ['network', { status: 'offline' }],
    ['auth', { status: 'login-required' }],
  ] as const)('maps a %s history failure to the %j state', async (reason, expected) => {
    const repository = createRepository();
    const history: HistoryClient = {
      async fetchHistory() {
        return { ok: false, reason };
      },
    };
    const { sync } = createSync(repository, history);

    await sync.sync({ reason: 'manual' });

    expect(sync.status()).toEqual(expected);
  });

  it.each([
    ['server', true],
    ['malformed', false],
  ] as const)('maps a %s history failure to failed with retryable %s', async (reason, retryable) => {
    const repository = createRepository();
    const history: HistoryClient = {
      async fetchHistory() {
        return { ok: false, reason };
      },
    };
    const { sync } = createSync(repository, history);

    await sync.sync({ reason: 'manual' });

    expect(sync.status()).toEqual({ status: 'failed', retryable, finishedAt: NOW });
  });

  it('moves off a terminal failure state when a later run succeeds', async () => {
    const repository = createRepository();
    const { client } = createHistoryClient([
      { ok: false, reason: 'network' },
      okPage([]),
    ]);
    const { sync } = createSync(repository, client);

    await sync.sync({ reason: 'manual' });
    expect(sync.status()).toEqual({ status: 'offline' });

    await sync.sync({ reason: 'manual' });
    expect(sync.status()).toEqual({ status: 'current', finishedAt: NOW });
  });
});

describe('ActivitySync single-flight', () => {
  it('returns the same in-flight promise to concurrent callers and issues one fetch chain', async () => {
    const repository = createRepository();
    let resolveFetch!: (result: HistoryFetchResult) => void;
    const fetchHistory = vi
      .fn<HistoryClient['fetchHistory']>()
      .mockImplementation(
        () =>
          new Promise<HistoryFetchResult>((resolve) => {
            resolveFetch = resolve;
          }),
      );

    const { sync } = createSync(repository, { fetchHistory });

    const first = sync.sync({ reason: 'manual' });
    const second = sync.sync({ reason: 'reconnect' });

    expect(second).toBe(first);
    expect(fetchHistory).toHaveBeenCalledTimes(1);
    expect(sync.status().status).toBe('syncing');

    resolveFetch(okPage([]));

    await expect(first).resolves.toEqual({ status: 'completed', recovered: 0, pages: 1 });
    expect(sync.status().status).toBe('current');
  });

  it('lets a later call start a fresh run after the previous one settles', async () => {
    const repository = createRepository();
    const { client, calls } = createHistoryClient([okPage([]), okPage([])]);
    const { sync } = createSync(repository, client);

    await sync.sync({ reason: 'manual' });
    await sync.sync({ reason: 'manual' });

    expect(calls).toHaveLength(2);
  });
});

describe('ActivitySync recovery runs', () => {
  it('recovers, inserts, and broadcasts fixture events on a reconnect trigger', async () => {
    const repository = createRepository();
    const events = await fixtureEvents();
    const { client } = createHistoryClient([okPage(events)]);
    const { sync, broadcast, health } = createSync(repository, client);

    const result = await sync.sync({ reason: 'reconnect' });

    expect(result).toEqual({ status: 'completed', recovered: 4, pages: 1 });
    expect(await repository.page({ limit: 50 })).toHaveLength(4);
    expect(broadcast).toHaveBeenCalledTimes(4);

    for (const event of events) {
      expect(broadcast).toHaveBeenCalledWith({
        protocolVersion: 1,
        type: 'activity.broadcast',
        payload: { event, toast: true },
      });
    }

    expect(health.record).toHaveBeenCalledWith({
      type: 'activity.recovered',
      at: NOW,
      count: 4,
    });
  });

  it('recovers on manual and stale-panel-open triggers the same way', async () => {
    const events = await fixtureEvents();

    for (const reason of ['manual', 'stale-panel-open'] as const) {
      const repository = createRepository();
      const { client } = createHistoryClient([okPage(events)]);
      const { sync, broadcast } = createSync(repository, client);

      await sync.sync({ reason });

      expect(broadcast).toHaveBeenCalledTimes(4);
      expect(await repository.page({ limit: 50 })).toHaveLength(4);
    }
  });

  it('skips duplicates without broadcasting or counting them', async () => {
    const repository = createRepository();
    const events = await fixtureEvents();

    // The newest fixture event is already stored.
    await repository.insert(events[0]!);

    const { client } = createHistoryClient([okPage(events)]);
    const { sync, broadcast, health } = createSync(repository, client);

    const result = await sync.sync({ reason: 'manual' });

    expect(result).toEqual({ status: 'completed', recovered: 3, pages: 1 });
    expect(await repository.page({ limit: 50 })).toHaveLength(4);
    expect(broadcast).toHaveBeenCalledTimes(3);
    expect(broadcast).not.toHaveBeenCalledWith(
      expect.objectContaining({
        payload: { event: events[0], toast: true },
      }),
    );
    expect(health.record).toHaveBeenCalledWith({
      type: 'activity.recovered',
      at: NOW,
      count: 3,
    });
  });

  it('honors the bounded recovery gap and stops pagination at the boundary', async () => {
    const repository = createRepository();
    const watermark = NOW - 60_000;

    const newest = makeEvent({ id: 'fomo:new', occurredAt: watermark + 10_000 });
    const atBound = makeEvent({ id: 'fomo:at-bound', occurredAt: watermark });
    const older = makeEvent({ id: 'fomo:older', occurredAt: watermark - 10_000 });

    const { client, calls } = createHistoryClient([
      okPage([newest, atBound], 'cursor-1'),
      okPage([older]),
    ]);
    const { sync } = createSync(repository, client);
    sync.seedLatest(watermark);

    const result = await sync.sync({ reason: 'reconnect' });

    // Only the strictly-newer event is inserted; the page containing the
    // boundary proves every later page is older, so no second fetch happens.
    expect(result).toEqual({ status: 'completed', recovered: 1, pages: 1 });
    expect(calls).toHaveLength(1);
    expect(await repository.get('fomo:new')).toBeDefined();
    expect(await repository.get('fomo:at-bound')).toBeUndefined();
    expect(await repository.get('fomo:older')).toBeUndefined();
  });

  it('never recovers further back than the configured max gap on a cold start', async () => {
    const repository = createRepository();
    const oldEvent = makeEvent({ id: 'fomo:old', occurredAt: NOW - DEFAULT_MAX_RECOVERY_GAP_MS - 1_000 });
    const recentEvent = makeEvent({ id: 'fomo:recent', occurredAt: NOW - 1_000 });

    const { client } = createHistoryClient([okPage([recentEvent, oldEvent])]);
    const { sync } = createSync(repository, client);

    await sync.sync({ reason: 'manual' });

    expect(await repository.get('fomo:recent')).toBeDefined();
    expect(await repository.get('fomo:old')).toBeUndefined();
  });

  it('follows nextCursor across pages while every event stays above the bound', async () => {
    const repository = createRepository();
    const firstPage = makeEvent({ id: 'fomo:page-1', occurredAt: NOW - 1_000 });
    const secondPage = makeEvent({ id: 'fomo:page-2', occurredAt: NOW - 2_000 });

    const { client, calls } = createHistoryClient([
      okPage([firstPage], 'cursor-1'),
      okPage([secondPage]),
    ]);
    const { sync } = createSync(repository, client);

    const result = await sync.sync({ reason: 'manual' });

    expect(result).toEqual({ status: 'completed', recovered: 2, pages: 2 });
    expect(calls[0]?.cursor).toBeUndefined();
    expect(calls[1]?.cursor).toBe('cursor-1');
    expect(await repository.get('fomo:page-1')).toBeDefined();
    expect(await repository.get('fomo:page-2')).toBeDefined();
  });

  it('raises the watermark from inserted events so a later run stops there', async () => {
    const repository = createRepository();
    const firstRun = makeEvent({ id: 'fomo:first', occurredAt: NOW - 1_000 });
    const secondRun = makeEvent({ id: 'fomo:second', occurredAt: NOW - 500 });

    const { client } = createHistoryClient([
      okPage([firstRun]),
      // newest-first: secondRun is newer than firstRun.
      okPage([secondRun, firstRun]),
    ]);
    const { sync } = createSync(repository, client);

    await sync.sync({ reason: 'manual' });

    // The second run sees firstRun at or below the (raised) watermark and
    // stops at the boundary: only secondRun is inserted.
    const result = await sync.sync({ reason: 'manual' });

    expect(result).toEqual({ status: 'completed', recovered: 1, pages: 1 });
    expect(await repository.get('fomo:second')).toBeDefined();
  });

  it('caps the number of pages fetched', async () => {
    const repository = createRepository();
    const event = makeEvent({ id: 'fomo:loop', occurredAt: NOW - 1_000 });

    const pages: HistoryFetchResult[] = Array.from(
      { length: MAX_RECOVERY_PAGES + 1 },
      () => okPage([event], 'cursor-loop'),
    );

    const { client, calls } = createHistoryClient(pages);
    const { sync } = createSync(repository, client, { options: { maxPages: MAX_RECOVERY_PAGES } });

    const result = await sync.sync({ reason: 'manual' });

    expect(result).toMatchObject({ status: 'completed' });
    expect(calls).toHaveLength(MAX_RECOVERY_PAGES);
  });

  it('seeds the watermark from the newest stored event', async () => {
    const repository = createRepository();
    const storedNew = makeEvent({ id: 'fomo:stored-new', occurredAt: NOW - 3_000 });
    const brandNew = makeEvent({ id: 'fomo:brand-new', occurredAt: NOW - 1_000 });
    await repository.insert(storedNew);
    await repository.insert(
      makeEvent({ id: 'fomo:stored-old', occurredAt: NOW - 30_000 }),
    );

    const { client } = createHistoryClient([okPage([brandNew, storedNew])]);
    const { sync } = createSync(repository, client);

    await sync.seedFromStored();

    const result = await sync.sync({ reason: 'manual' });

    // storedNew sits at the seeded watermark and is not re-fetched/inserted;
    // only brandNew is recovered.
    expect(result).toEqual({ status: 'completed', recovered: 1, pages: 1 });
    expect(await repository.get('fomo:brand-new')).toBeDefined();
    expect(await repository.get('fomo:stored-new')).toBeDefined();
  });
});
