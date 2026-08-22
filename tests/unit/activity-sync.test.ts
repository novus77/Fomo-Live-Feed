import 'fake-indexeddb/auto';

import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TradeEventV1 } from '../../src/domain/activity';
import {
  ActivitySync,
  DEFAULT_MAX_RECOVERY_GAP_MS,
  MAX_RECOVERY_PAGES,
  RECOVERY_CONTINUATION_CURSOR_STORAGE_KEY,
  RECOVERY_CURSOR_STORAGE_KEY,
  type ActivitySyncDependencies,
  type ContinuationCursor,
  type RecoveryCursor,
  type RecoveryCursorStorage,
} from '../../src/background/activity-sync';
import type { IngestOutcome } from '../../src/background/ingest-activity';
import type { ActivityBroadcastMessage } from '../../src/messaging/protocol';
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

const createCursorStorage = (initial?: {
  recovery?: RecoveryCursor;
  continuation?: ContinuationCursor;
}): RecoveryCursorStorage & {
  records: Record<string, unknown>;
} => {
  const records: Record<string, unknown> = {};

  if (initial?.recovery !== undefined) {
    records[RECOVERY_CURSOR_STORAGE_KEY] = initial.recovery;
  }

  if (initial?.continuation !== undefined) {
    records[RECOVERY_CONTINUATION_CURSOR_STORAGE_KEY] = initial.continuation;
  }

  return {
    records,
    async get(keys: string[]): Promise<Record<string, unknown>> {
      const result: Record<string, unknown> = {};

      for (const key of keys) {
        if (key in records) {
          result[key] = records[key];
        }
      }

      return result;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      Object.assign(records, items);
    },
    async remove(keys: string[]): Promise<void> {
      for (const key of keys) {
        delete records[key];
      }
    },
  };
};

const createSync = (
  repository: EventRepository,
  history: HistoryClient,
  extras: {
    broadcast?: (message: ActivityBroadcastMessage) => void | Promise<void>;
    ingestor?: ActivitySyncDependencies['ingestor'];
    health?: ActivitySyncDependencies['health'];
    storage?: ActivitySyncDependencies['storage'];
    now?: () => number;
    options?: ConstructorParameters<typeof ActivitySync>[1];
  } = {},
) => {
  const broadcast = extras.broadcast ?? vi.fn();
  const health = extras.health ?? { record: vi.fn() };
  const ingestor = extras.ingestor ?? {
    async ingestRecovered(event: TradeEventV1): Promise<IngestOutcome> {
      const inserted = await repository.insert(event);

      if (!inserted) {
        return { status: 'duplicate', event };
      }

      await broadcast({
        protocolVersion: 1,
        type: 'activity.broadcast',
        payload: { event },
      });

      return { status: 'inserted', event, enrichment: Promise.resolve() };
    },
  };
  const sync = new ActivitySync(
    {
      events: {
        page: (query) => repository.page(query),
      },
      ingestor,
      history,
      health,
      ...(extras.storage !== undefined ? { storage: extras.storage } : {}),
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
    const second = sync.sync({ reason: 'manual' });

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

  it('schedules a follow-up run when a different trigger arrives while in flight', async () => {
    const repository = createRepository();
    const resolvers: Array<(result: HistoryFetchResult) => void> = [];
    const fetchHistory = vi
      .fn<HistoryClient['fetchHistory']>()
      .mockImplementation(
        () =>
          new Promise<HistoryFetchResult>((resolve) => {
            resolvers.push(resolve);
          }),
      );

    const { sync } = createSync(repository, { fetchHistory });

    const first = sync.sync({ reason: 'reconnect' });
    const second = sync.sync({ reason: 'manual' });

    // Same-trigger single-flight is preserved, but a different trigger must
    // not return the in-flight promise: it is backed by the follow-up run.
    expect(second).not.toBe(first);
    expect(sync.status()).toEqual({
      status: 'syncing',
      reason: 'reconnect',
      startedAt: NOW,
      pendingFollowUp: true,
    });

    resolvers[0]!(okPage([]));

    await expect(first).resolves.toEqual({ status: 'completed', recovered: 0, pages: 1 });

    // The follow-up is now in flight.
    expect(fetchHistory).toHaveBeenCalledTimes(2);

    resolvers[1]!(okPage([]));

    await expect(second).resolves.toEqual({ status: 'completed', recovered: 0, pages: 1 });
  });

  it('coalesces multiple overlapping requests into a single follow-up run', async () => {
    const repository = createRepository();
    const resolvers: Array<(result: HistoryFetchResult) => void> = [];
    const fetchHistory = vi
      .fn<HistoryClient['fetchHistory']>()
      .mockImplementation(
        () =>
          new Promise<HistoryFetchResult>((resolve) => {
            resolvers.push(resolve);
          }),
      );

    const { sync } = createSync(repository, { fetchHistory });

    const first = sync.sync({ reason: 'reconnect' });
    const second = sync.sync({ reason: 'manual' });
    const third = sync.sync({ reason: 'stale-panel-open' });

    // All overlapping requests with different triggers collapse into one
    // follow-up; second and third share the same deferred promise.
    expect(second).toBe(third);
    expect(second).not.toBe(first);

    resolvers[0]!(okPage([]));

    await first;

    // Exactly two fetch chains: the original run plus one coalesced follow-up.
    expect(fetchHistory).toHaveBeenCalledTimes(2);

    resolvers[1]!(okPage([]));

    await second;
    await third;
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
        payload: { event },
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
        payload: { event: events[0] },
      }),
    );
    expect(health.record).toHaveBeenCalledWith({
      type: 'activity.recovered',
      at: NOW,
      count: 3,
    });
  });

  it('honors the bounded recovery gap and stops pagination at the overlap-adjusted boundary', async () => {
    const repository = createRepository();
    const watermark = NOW - 60_000;

    const newest = makeEvent({ id: 'fomo:new', occurredAt: watermark + 10_000 });
    const inOverlap = makeEvent({ id: 'fomo:in-overlap', occurredAt: watermark });
    const older = makeEvent({ id: 'fomo:older', occurredAt: watermark - 10_000 });
    const oldest = makeEvent({ id: 'fomo:oldest', occurredAt: watermark - 20_000 });

    const { client, calls } = createHistoryClient([
      okPage([newest, inOverlap, older], 'cursor-1'),
      okPage([oldest]),
    ]);
    const { sync } = createSync(repository, client);
    sync.seedLatest(watermark);

    const result = await sync.sync({ reason: 'reconnect' });

    // The default overlap window (5s) shifts the bound BELOW the watermark:
    // `newest` and `inOverlap` (at the watermark, inside the window) are
    // recovered. `older` (10s below the watermark) sits at-or-below the bound;
    // the mixed page keeps the above-bound events and stops pagination after
    // it — `oldest` is never fetched.
    expect(result).toEqual({ status: 'completed', recovered: 2, pages: 1 });
    expect(calls).toHaveLength(1);
    expect(await repository.get('fomo:new')).toBeDefined();
    expect(await repository.get('fomo:in-overlap')).toBeDefined();
    expect(await repository.get('fomo:older')).toBeUndefined();
    expect(await repository.get('fomo:oldest')).toBeUndefined();
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

  it('fails retryably when maxPages is reached before the lower bound is seen', async () => {
    const repository = createRepository();
    const event = makeEvent({ id: 'fomo:loop', occurredAt: NOW - 1_000 });

    const pages: HistoryFetchResult[] = Array.from(
      { length: MAX_RECOVERY_PAGES + 1 },
      () => okPage([event], 'cursor-loop'),
    );

    const { client, calls } = createHistoryClient(pages);
    const { sync } = createSync(repository, client, {
      options: { maxPages: MAX_RECOVERY_PAGES },
    });

    const result = await sync.sync({ reason: 'manual' });

    // maxPages reached, nextCursor still present, bound never seen: the
    // backfill is incomplete and the run reports a retryable failure.
    expect(result).toEqual({ status: 'failed', reason: 'bounded-pagination' });
    expect(sync.status()).toEqual({ status: 'failed', retryable: true, finishedAt: NOW });
    expect(calls).toHaveLength(MAX_RECOVERY_PAGES);
  });

  it('does not advance the watermark when pagination reaches maxPages', async () => {
    const repository = createRepository();
    // Events far below the seeded watermark but above the cold-start floor:
    // whether the second run recovers them discriminates an advanced watermark.
    const loopEvent = makeEvent({ id: 'fomo:loop', occurredAt: NOW - 30_000 });
    const laterEvent = makeEvent({ id: 'fomo:later', occurredAt: NOW - 40_000 });

    let calls = 0;
    const history: HistoryClient = {
      async fetchHistory() {
        calls += 1;

        if (calls <= MAX_RECOVERY_PAGES) {
          return okPage([loopEvent], 'cursor-loop');
        }

        return okPage([laterEvent]);
      },
    };
    const { sync } = createSync(repository, history, {
      options: { maxPages: MAX_RECOVERY_PAGES },
    });
    sync.seedLatest(NOW - 60_000);

    const first = await sync.sync({ reason: 'manual' });

    expect(first).toEqual({ status: 'failed', reason: 'bounded-pagination' });

    // The watermark was NOT advanced past NOW-60s, so the second run's bound
    // still sits at NOW-65s (watermark minus the overlap) and the NOW-40s
    // event is recovered. Had the watermark moved to the loop event, NOW-40s
    // would fall below the bound and be skipped.
    const second = await sync.sync({ reason: 'manual' });

    expect(second).toEqual({ status: 'completed', recovered: 1, pages: 1 });
    expect(await repository.get('fomo:later')).toBeDefined();
  });

  it('routes every above-bound event through the injected ingestor.ingestRecovered and never calls it for boundary events', async () => {
    const repository = createRepository();
    const above = makeEvent({ id: 'fomo:above', occurredAt: NOW - 1_000 });
    // At-or-below the cold-start bound (maxGapMs from now): the page is read
    // in full, but this event must never reach the ingestor.
    const atBoundary = makeEvent({
      id: 'fomo:boundary',
      occurredAt: NOW - DEFAULT_MAX_RECOVERY_GAP_MS - 1_000,
    });
    const ingestRecovered = vi.fn(
      async (event: TradeEventV1): Promise<IngestOutcome> => {
        const inserted = await repository.insert(event);
        return inserted
          ? { status: 'inserted', event, enrichment: Promise.resolve() }
          : { status: 'duplicate', event };
      },
    );
    const { client, calls } = createHistoryClient([okPage([above, atBoundary], 'cursor-1')]);
    const { sync } = createSync(repository, client, { ingestor: { ingestRecovered } });

    const result = await sync.sync({ reason: 'manual' });

    expect(result).toEqual({ status: 'completed', recovered: 1, pages: 1 });
    // The ingestor is the ONLY write path: it saw exactly the above-bound
    // event, never the boundary event (which only stops pagination).
    expect(ingestRecovered).toHaveBeenCalledTimes(1);
    expect(ingestRecovered).toHaveBeenCalledWith(above);
    expect(ingestRecovered).not.toHaveBeenCalledWith(atBoundary);
    expect(await repository.get('fomo:boundary')).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it('routes every page event through the injected ingestor and skips duplicate outcomes without counting them', async () => {
    const repository = createRepository();
    const events = await fixtureEvents();
    // The newest fixture event is already stored: its recovery returns
    // 'duplicate' and must not count or write again.
    await repository.insert(events[0]!);

    const seen: string[] = [];
    const ingestRecovered = vi.fn(
      async (event: TradeEventV1): Promise<IngestOutcome> => {
        seen.push(event.id);
        const inserted = await repository.insert(event);
        return inserted
          ? { status: 'inserted', event, enrichment: Promise.resolve() }
          : { status: 'duplicate', event };
      },
    );
    const { client } = createHistoryClient([okPage(events)]);
    const { sync } = createSync(repository, client, { ingestor: { ingestRecovered } });

    const result = await sync.sync({ reason: 'manual' });

    // All four page events reach the ingestor; the duplicate is skipped in
    // the coordinator, so only three count as recovered.
    expect(seen).toEqual(events.map((event) => event.id));
    expect(ingestRecovered).toHaveBeenCalledTimes(4);
    expect(result).toEqual({ status: 'completed', recovered: 3, pages: 1 });
    expect(await repository.page({ limit: 50 })).toHaveLength(4);
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

    // storedNew sits at the seeded watermark (inside the overlap window) and
    // is deduplicated, not re-inserted or re-broadcast; only brandNew is
    // recovered.
    expect(result).toEqual({ status: 'completed', recovered: 1, pages: 1 });
    expect(await repository.get('fomo:brand-new')).toBeDefined();
    expect(await repository.get('fomo:stored-new')).toBeDefined();
  });
});

describe('ActivitySync composite cursor', () => {
  it('recovers a same-millisecond event whose id sorts after the cursor id at the exact bound', async () => {
    const repository = createRepository();
    // A watermark exactly maxGapMs before now: the max-gap floor equals the
    // watermark time, so the bound coincides with the watermark and the id
    // component of the composite cursor decides what is recovered.
    const shared = NOW - DEFAULT_MAX_RECOVERY_GAP_MS;
    const before = makeEvent({ id: 'fomo:aaaa', occurredAt: shared });
    const after = makeEvent({ id: 'fomo:zzzz', occurredAt: shared });
    const older = makeEvent({ id: 'fomo:older', occurredAt: shared - 1 });

    const storage = createCursorStorage({
      recovery: {
        latestEventOccurredAt: shared,
        latestEventId: 'fomo:aaaa',
        finishedAt: NOW,
      },
    });
    const { client } = createHistoryClient([okPage([before, after, older])]);
    const { sync } = createSync(repository, client, { storage });

    expect(await sync.seedFromCursor()).toBe(true);

    const result = await sync.sync({ reason: 'manual' });

    // 'fomo:zzzz' shares the watermark millisecond but sorts after the cursor
    // id: recovered. 'fomo:aaaa' is at-or-before the cursor: skipped. The
    // older event is below the bound: boundary, stop.
    expect(result).toEqual({ status: 'completed', recovered: 1, pages: 1 });
    expect(await repository.get('fomo:zzzz')).toBeDefined();
    expect(await repository.get('fomo:aaaa')).toBeUndefined();
    expect(await repository.get('fomo:older')).toBeUndefined();
  });

  it('re-examines the overlap window so same-millisecond out-of-order arrivals are not lost', async () => {
    const repository = createRepository();
    // The live stream already stored an event at the watermark...
    const stored = makeEvent({ id: 'fomo:stored', occurredAt: NOW - 60_000 });
    await repository.insert(stored);

    // ...but a second event at the SAME millisecond arrived late (out of
    // order). It sits inside the overlap window and must be recovered, not
    // skipped as if it were at-or-before the watermark.
    const late = makeEvent({ id: 'fomo:late', occurredAt: NOW - 60_000 });

    const { client } = createHistoryClient([okPage([stored, late])]);
    const { sync } = createSync(repository, client);
    sync.seedLatest(NOW - 60_000);

    const result = await sync.sync({ reason: 'reconnect' });

    expect(result).toEqual({ status: 'completed', recovered: 1, pages: 1 });
    expect(await repository.get('fomo:late')).toBeDefined();
    expect(await repository.get('fomo:stored')).toBeDefined();
  });
});

describe('ActivitySync persisted recovery cursor', () => {
  it('persists the composite cursor after a successful run', async () => {
    const repository = createRepository();
    const storage = createCursorStorage();
    const event = makeEvent({ id: 'fomo:new', occurredAt: NOW - 1_000 });
    const { client } = createHistoryClient([okPage([event])]);
    const { sync } = createSync(repository, client, { storage });

    await sync.sync({ reason: 'manual' });

    const stored = (await storage.get([RECOVERY_CURSOR_STORAGE_KEY]))[
      RECOVERY_CURSOR_STORAGE_KEY
    ];

    expect(stored).toEqual({
      latestEventOccurredAt: NOW - 1_000,
      latestEventId: 'fomo:new',
      finishedAt: NOW,
    });
  });

  it('persists a time-only cursor (no id) when a run found nothing new after a time-only seed', async () => {
    const repository = createRepository();
    const storage = createCursorStorage();
    // A watermark exactly maxGapMs before now: the max-gap floor equals the
    // watermark, so the bound coincides with the watermark and the id
    // component of the composite cursor decides what is recovered.
    const watermark = NOW - DEFAULT_MAX_RECOVERY_GAP_MS;
    // The stored event sits AT the watermark with no id component: the run
    // skips it (nothing new) and ends 'current', so the persisted cursor
    // carries ONLY the time watermark seeded via seedLatest() — the
    // documented time-only cursor shape.
    const stored = makeEvent({ id: 'fomo:stored', occurredAt: watermark });
    await repository.insert(stored);

    const { client } = createHistoryClient([okPage([stored])]);
    const { sync } = createSync(repository, client, { storage });
    sync.seedLatest(watermark);

    await sync.sync({ reason: 'manual' });

    expect(sync.status()).toEqual({ status: 'current', finishedAt: NOW });
    const persisted = (await storage.get([RECOVERY_CURSOR_STORAGE_KEY]))[
      RECOVERY_CURSOR_STORAGE_KEY
    ];
    expect(persisted).toEqual({ latestEventOccurredAt: watermark, finishedAt: NOW });

    // The time-only cursor round-trips: a fresh instance restores the
    // watermark WITHOUT an id component, so a same-millisecond event with a
    // lexicographically LATER id is still skipped at the exact bound — an
    // id-bearing cursor would have recovered it (see the composite-cursor
    // tests).
    const sameMs = makeEvent({ id: 'fomo:zzzz', occurredAt: watermark });
    const { client: freshClient } = createHistoryClient([okPage([sameMs])]);
    const { sync: freshSync } = createSync(repository, freshClient, { storage });

    expect(await freshSync.seedFromCursor()).toBe(true);

    const result = await freshSync.sync({ reason: 'manual' });

    expect(result).toEqual({ status: 'completed', recovered: 0, pages: 1 });
    expect(await repository.get('fomo:zzzz')).toBeUndefined();
  });

  it('does not write a cursor after a failed run', async () => {
    const repository = createRepository();
    const storage = createCursorStorage();
    const history: HistoryClient = {
      async fetchHistory() {
        return { ok: false, reason: 'network' };
      },
    };
    const { sync } = createSync(repository, history, { storage });

    await sync.sync({ reason: 'manual' });

    expect(storage.records[RECOVERY_CURSOR_STORAGE_KEY]).toBeUndefined();
  });

  it('does not write a cursor when pagination hits maxPages (retryable failure)', async () => {
    const repository = createRepository();
    const storage = createCursorStorage();
    const event = makeEvent({ id: 'fomo:loop', occurredAt: NOW - 1_000 });
    const pages: HistoryFetchResult[] = Array.from(
      { length: MAX_RECOVERY_PAGES },
      () => okPage([event], 'cursor-loop'),
    );
    const { client } = createHistoryClient(pages);
    const { sync } = createSync(repository, client, {
      storage,
      options: { maxPages: MAX_RECOVERY_PAGES },
    });

    await sync.sync({ reason: 'manual' });

    expect(storage.records[RECOVERY_CURSOR_STORAGE_KEY]).toBeUndefined();
  });

  it('seeds the composite watermark from a persisted cursor and reports false when absent', async () => {
    const repository = createRepository();
    const shared = NOW - 60_000;
    const storage = createCursorStorage({
      recovery: {
        latestEventOccurredAt: shared,
        latestEventId: 'fomo:aaaa',
        finishedAt: NOW - 10_000,
      },
    });
    const sameMs = makeEvent({ id: 'fomo:zzzz', occurredAt: shared });
    const { client } = createHistoryClient([okPage([sameMs])]);
    const { sync } = createSync(repository, client, { storage });

    // A valid cursor seeds the composite watermark (time + id).
    expect(await sync.seedFromCursor()).toBe(true);

    // A second instance with EMPTY storage finds no cursor and falls back.
    const empty = createSync(repository, client, { storage: createCursorStorage() });
    expect(await empty.sync.seedFromCursor()).toBe(false);
  });

  it('ignores a corrupt cursor record and reports false', async () => {
    const repository = createRepository();
    const storage = createCursorStorage();
    storage.records[RECOVERY_CURSOR_STORAGE_KEY] = {
      latestEventOccurredAt: 'not-a-number',
      finishedAt: NOW,
    };
    const { sync } = createSync(repository, createHistoryClient([]).client, { storage });

    expect(await sync.seedFromCursor()).toBe(false);
  });

  it('persists a continuation cursor when pagination hits maxPages and resumes from it', async () => {
    const repository = createRepository();
    const storage = createCursorStorage();
    const watermark = NOW - 60_000;
    const event = makeEvent({ id: 'fomo:loop', occurredAt: watermark - 1_000 });

    const pages: HistoryFetchResult[] = Array.from(
      { length: MAX_RECOVERY_PAGES },
      () => okPage([event], 'cursor-page-21'),
    );

    const { client } = createHistoryClient(pages);
    const { sync } = createSync(repository, client, {
      storage,
      options: { maxPages: MAX_RECOVERY_PAGES },
    });
    sync.seedLatest(watermark);

    const first = await sync.sync({ reason: 'manual' });

    expect(first).toEqual({ status: 'failed', reason: 'bounded-pagination' });

    const continuation = storage.records[RECOVERY_CONTINUATION_CURSOR_STORAGE_KEY] as
      | ContinuationCursor
      | undefined;

    expect(continuation).toEqual({
      cursor: 'cursor-page-21',
      latestEventOccurredAt: watermark,
      createdAt: NOW,
    });

    // A fresh sync instance with the same watermark resumes from the
    // continuation cursor instead of restarting from the newest page.
    const resumedCalls: Array<{ cursor: string | undefined; limit: number }> = [];
    const resumedHistory: HistoryClient = {
      async fetchHistory(options) {
        resumedCalls.push({ cursor: options.cursor, limit: options.limit });

        return okPage([]);
      },
    };
    const { sync: resumedSync } = createSync(repository, resumedHistory, { storage });
    resumedSync.seedLatest(watermark);

    await resumedSync.sync({ reason: 'manual' });

    expect(resumedCalls).toHaveLength(1);
    expect(resumedCalls[0]?.cursor).toBe('cursor-page-21');
  });

  it('clears the continuation cursor after a successful run', async () => {
    const repository = createRepository();
    const watermark = NOW - 60_000;
    const event = makeEvent({ id: 'fomo:new', occurredAt: watermark + 1_000 });
    const storage = createCursorStorage({
      continuation: {
        cursor: 'cursor-old',
        latestEventOccurredAt: watermark,
        createdAt: NOW - 10_000,
      },
    });

    const { client } = createHistoryClient([okPage([event])]);
    const { sync } = createSync(repository, client, { storage });
    sync.seedLatest(watermark);

    await sync.sync({ reason: 'manual' });

    expect(storage.records[RECOVERY_CONTINUATION_CURSOR_STORAGE_KEY]).toBeUndefined();
  });

  it('discards a stale continuation cursor when the watermark has advanced past it', async () => {
    const repository = createRepository();
    const watermark = NOW - 60_000;
    const newerEvent = makeEvent({ id: 'fomo:new', occurredAt: watermark + 10_000 });
    const storage = createCursorStorage({
      continuation: {
        cursor: 'cursor-old',
        latestEventOccurredAt: watermark,
        createdAt: NOW - 10_000,
      },
    });

    const calls: Array<{ cursor: string | undefined; limit: number }> = [];
    const history: HistoryClient = {
      async fetchHistory(options) {
        calls.push({ cursor: options.cursor, limit: options.limit });

        return okPage([newerEvent]);
      },
    };

    const { sync } = createSync(repository, history, { storage });
    sync.seedLatest(watermark);
    // The live pipeline advanced past the cursor watermark.
    sync.observeEvent(newerEvent);

    await sync.sync({ reason: 'manual' });

    expect(calls[0]?.cursor).toBeUndefined();
    expect(storage.records[RECOVERY_CONTINUATION_CURSOR_STORAGE_KEY]).toBeUndefined();
  });
});
