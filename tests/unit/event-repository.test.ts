import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import type { TradeEventV1 } from '../../src/domain/activity';
import { FomoFeedDatabase } from '../../src/storage/database';
import {
  EventRepository,
  type EventPageQuery,
} from '../../src/storage/event-repository';
import {
  MetricRepository,
  type MetricCacheRecord,
} from '../../src/storage/metric-repository';

const openDatabases: FomoFeedDatabase[] = [];

const createDatabase = () => {
  const database = new FomoFeedDatabase(`test-db-${crypto.randomUUID()}`);
  openDatabases.push(database);

  return database;
};

const createEvent = (
  overrides: Partial<TradeEventV1> & Pick<TradeEventV1, 'id' | 'occurredAt'>,
): TradeEventV1 => ({
  schemaVersion: 1,
  id: overrides.id,
  source: 'fomo',
  traderId: overrides.traderId ?? 'trader-a',
  traderHandle: overrides.traderHandle ?? 'alpha',
  chain: overrides.chain ?? 'solana',
  tokenAddress: overrides.tokenAddress ?? 'token-a',
  tokenSymbol: overrides.tokenSymbol ?? 'AAA',
  action: overrides.action ?? 'buy',
  occurredAt: overrides.occurredAt,
  receivedAt: overrides.receivedAt ?? overrides.occurredAt + 1,
  ...(overrides.readAt === undefined ? {} : { readAt: overrides.readAt }),
  ...(overrides.marketCap === undefined ? {} : { marketCap: overrides.marketCap }),
  ...(overrides.metricSnapshot === undefined
    ? {}
    : { metricSnapshot: overrides.metricSnapshot }),
});

const createMetricRecord = (
  overrides: Partial<MetricCacheRecord> & Pick<MetricCacheRecord, 'traderId' | 'expiresAt'>,
): MetricCacheRecord => ({
  traderId: overrides.traderId,
  expiresAt: overrides.expiresAt,
  fetchedAt: overrides.fetchedAt ?? overrides.expiresAt - 100,
  source: overrides.source ?? 'fomo-profile',
  ...(overrides.pnl7d === undefined ? {} : { pnl7d: overrides.pnl7d }),
  ...(overrides.winRate7d === undefined ? {} : { winRate7d: overrides.winRate7d }),
  ...(overrides.followers === undefined ? {} : { followers: overrides.followers }),
  ...(overrides.tradeCount === undefined ? {} : { tradeCount: overrides.tradeCount }),
  ...(overrides.averageHoldSeconds === undefined
    ? {}
    : { averageHoldSeconds: overrides.averageHoldSeconds }),
});

afterEach(async () => {
  await Promise.all(
    openDatabases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe('FomoFeedDatabase', () => {
  it('configures the expected default name, version 1 schema, and indexes', async () => {
    const defaultDatabase = new FomoFeedDatabase();
    openDatabases.push(defaultDatabase);
    const database = createDatabase();

    expect(defaultDatabase.name).toBe('fomo-live-feed');
    expect(database.events.schema.primKey.name).toBe('id');
    expect(database.events.schema.indexes.map((index) => index.name)).toEqual([
      'occurredAt',
      '[traderId+occurredAt]',
      '[chain+occurredAt]',
      '[tokenAddress+occurredAt]',
      'readAt',
    ]);
    expect(database.metrics.schema.primKey.name).toBe('traderId');
    expect(database.metrics.schema.indexes.map((index) => index.name)).toEqual([
      'expiresAt',
    ]);
  });
});

describe('EventRepository', () => {
  it('returns false when inserting a duplicate event id', async () => {
    const database = createDatabase();
    const repository = new EventRepository(database);
    const event = createEvent({ id: 'duplicate', occurredAt: 100 });

    await expect(repository.insert(event)).resolves.toBe(true);
    await expect(repository.insert(event)).resolves.toBe(false);
  });

  it('rethrows non-constraint insert errors', async () => {
    const repository = new EventRepository(
      {
        events: {
          add: async () => {
            throw new Error('disk offline');
          },
        },
      } as never,
    );

    await expect(
      repository.insert(createEvent({ id: 'boom', occurredAt: 100 })),
    ).rejects.toThrowError('disk offline');
  });

  it('returns newest-first pages using indexed queries', async () => {
    const database = createDatabase();
    const repository = new EventRepository(database);

    await repository.insert(createEvent({ id: 'oldest', occurredAt: 100 }));
    await repository.insert(createEvent({ id: 'middle', occurredAt: 200 }));
    await repository.insert(createEvent({ id: 'newest', occurredAt: 300 }));

    await expect(repository.page({ limit: 2 })).resolves.toEqual([
      expect.objectContaining({ id: 'newest' }),
      expect.objectContaining({ id: 'middle' }),
    ]);
  });

  it('applies the occurredAt cursor strictly before the provided timestamp', async () => {
    const database = createDatabase();
    const repository = new EventRepository(database);

    await repository.insert(createEvent({ id: 'three-hundred', occurredAt: 300 }));
    await repository.insert(createEvent({ id: 'two-hundred', occurredAt: 200 }));
    await repository.insert(createEvent({ id: 'one-hundred', occurredAt: 100 }));

    await expect(
      repository.page({ limit: 10, beforeOccurredAt: 200 }),
    ).resolves.toEqual([expect.objectContaining({ id: 'one-hundred' })]);
  });

  it('uses beforeId with beforeOccurredAt to continue through a same-timestamp tie bucket without duplicates or loss', async () => {
    const database = createDatabase();
    const repository = new EventRepository(database);
    const occurredAt = 1_000;

    for (let index = 0; index < 25; index += 1) {
      await repository.insert(
        createEvent({
          id: `tie-${index.toString().padStart(2, '0')}`,
          occurredAt,
        }),
      );
    }

    await repository.insert(createEvent({ id: 'older-1', occurredAt: 900 }));
    await repository.insert(createEvent({ id: 'older-0', occurredAt: 800 }));

    const firstPage = await repository.page({ limit: 10 });
    const firstCursor = firstPage.at(-1);
    const secondPage = await repository.page({
      limit: 10,
      ...(firstCursor
        ? {
            beforeOccurredAt: firstCursor.occurredAt,
            beforeId: firstCursor.id,
          }
        : {}),
    });
    const secondCursor = secondPage.at(-1);
    const thirdPage = await repository.page({
      limit: 10,
      ...(secondCursor
        ? {
            beforeOccurredAt: secondCursor.occurredAt,
            beforeId: secondCursor.id,
          }
        : {}),
    });

    const ids = [...firstPage, ...secondPage, ...thirdPage].map((event) => event.id);

    expect(firstPage.map((event) => event.id)).toEqual([
      'tie-24',
      'tie-23',
      'tie-22',
      'tie-21',
      'tie-20',
      'tie-19',
      'tie-18',
      'tie-17',
      'tie-16',
      'tie-15',
    ]);
    expect(secondPage.map((event) => event.id)).toEqual([
      'tie-14',
      'tie-13',
      'tie-12',
      'tie-11',
      'tie-10',
      'tie-09',
      'tie-08',
      'tie-07',
      'tie-06',
      'tie-05',
    ]);
    expect(thirdPage.map((event) => event.id)).toEqual([
      'tie-04',
      'tie-03',
      'tie-02',
      'tie-01',
      'tie-00',
      'older-1',
      'older-0',
    ]);
    expect(new Set(ids)).toHaveLength(ids.length);
  });

  it('uses over-fetching so unread filtering can still fill the requested page', async () => {
    const database = createDatabase();
    const repository = new EventRepository(database);

    const events = [
      createEvent({ id: 'read-5', occurredAt: 500, readAt: 600 }),
      createEvent({ id: 'read-4', occurredAt: 400, readAt: 600 }),
      createEvent({ id: 'unread-3', occurredAt: 300 }),
      createEvent({ id: 'unread-2', occurredAt: 200 }),
      createEvent({ id: 'unread-1', occurredAt: 100 }),
    ];

    for (const event of events) {
      await repository.insert(event);
    }

    await expect(repository.page({ limit: 2, unreadOnly: true })).resolves.toEqual([
      expect.objectContaining({ id: 'unread-3' }),
      expect.objectContaining({ id: 'unread-2' }),
    ]);
    await expect(repository.unreadCount()).resolves.toBe(3);
  });

  it('continues within the same occurredAt bucket when post-index filters reject the first internal batch', async () => {
    const database = createDatabase();
    const repository = new EventRepository(database);
    const occurredAt = 1_000;

    for (let index = 0; index < 70; index += 1) {
      await repository.insert(
        createEvent({
          id: `same-ts-${index.toString().padStart(2, '0')}`,
          occurredAt,
          traderId: 'target-trader',
          chain: index < 10 ? 'base' : 'solana',
        }),
      );
    }

    await expect(
      repository.page({
        limit: 10,
        traderId: 'target-trader',
        chain: 'base',
      }),
    ).resolves.toEqual(
      Array.from({ length: 10 }, (_, offset) =>
        expect.objectContaining({
          id: `same-ts-${(9 - offset).toString().padStart(2, '0')}`,
          traderId: 'target-trader',
          chain: 'base',
          occurredAt,
        }),
      ),
    );
  });

  it('filters by trader, chain, and token address', async () => {
    const database = createDatabase();
    const repository = new EventRepository(database);

    const matching = createEvent({
      id: 'match',
      occurredAt: 300,
      traderId: 'trader-42',
      chain: 'base',
      tokenAddress: 'token-42',
    });

    for (const event of [
      matching,
      createEvent({
        id: 'other-trader',
        occurredAt: 200,
        traderId: 'trader-other',
        chain: 'base',
        tokenAddress: 'token-42',
      }),
      createEvent({
        id: 'other-chain',
        occurredAt: 100,
        traderId: 'trader-42',
        chain: 'solana',
        tokenAddress: 'token-42',
      }),
    ]) {
      await repository.insert(event);
    }

    const query: EventPageQuery = {
      limit: 10,
      traderId: 'trader-42',
      chain: 'base',
      tokenAddress: 'token-42',
    };

    await expect(repository.page(query)).resolves.toEqual([
      expect.objectContaining({ id: 'match' }),
    ]);
  });

  it('filters by chain using the chain compound index and preserves newest-first order', async () => {
    const database = createDatabase();
    const repository = new EventRepository(database);

    for (const event of [
      createEvent({ id: 'base-new', occurredAt: 300, chain: 'base' }),
      createEvent({ id: 'solana-mid', occurredAt: 200, chain: 'solana' }),
      createEvent({ id: 'base-old', occurredAt: 100, chain: 'base' }),
    ]) {
      await repository.insert(event);
    }

    await expect(repository.page({ limit: 10, chain: 'base' })).resolves.toEqual([
      expect.objectContaining({ id: 'base-new' }),
      expect.objectContaining({ id: 'base-old' }),
    ]);
  });

  it('filters by tokenAddress using exact token matching', async () => {
    const database = createDatabase();
    const repository = new EventRepository(database);

    for (const event of [
      createEvent({ id: 'token-hit-new', occurredAt: 300, tokenAddress: 'token-42' }),
      createEvent({ id: 'token-near-miss', occurredAt: 200, tokenAddress: 'token-420' }),
      createEvent({ id: 'token-hit-old', occurredAt: 100, tokenAddress: 'token-42' }),
    ]) {
      await repository.insert(event);
    }

    await expect(
      repository.page({ limit: 10, tokenAddress: 'token-42' }),
    ).resolves.toEqual([
      expect.objectContaining({ id: 'token-hit-new' }),
      expect.objectContaining({ id: 'token-hit-old' }),
    ]);
  });

  it('returns an empty page for a tokenAddress that does not match exactly', async () => {
    const database = createDatabase();
    const repository = new EventRepository(database);

    await repository.insert(
      createEvent({ id: 'token-only', occurredAt: 100, tokenAddress: 'token-42' }),
    );

    await expect(
      repository.page({ limit: 10, tokenAddress: 'token-0042' }),
    ).resolves.toEqual([]);
  });

  it('marks existing events as read without deleting them', async () => {
    const database = createDatabase();
    const repository = new EventRepository(database);

    await repository.insert(createEvent({ id: 'event-1', occurredAt: 100 }));

    await expect(repository.markRead('event-1', 555)).resolves.toBe(true);
    await expect(repository.markRead('missing', 555)).resolves.toBe(false);
    await expect(repository.get('event-1')).resolves.toEqual(
      expect.objectContaining({ id: 'event-1', readAt: 555 }),
    );
  });

  it('rejects invalid pagination and read timestamps', async () => {
    const database = createDatabase();
    const repository = new EventRepository(database);

    await expect(repository.page({ limit: 0 })).rejects.toThrowError(
      'limit must be a positive integer',
    );
    await expect(
      repository.page({ limit: 10, beforeId: 'event-1' }),
    ).rejects.toThrowError('beforeId requires beforeOccurredAt');
    await expect(repository.markRead('event-1', -1)).rejects.toThrowError(
      'readAt must be a finite non-negative integer',
    );
  });

  it('orders tied timestamps deterministically and keeps legacy beforeOccurredAt-only cursor semantics', async () => {
    const database = createDatabase();
    const repository = new EventRepository(database);

    for (const event of [
      createEvent({ id: 'alpha', occurredAt: 100 }),
      createEvent({ id: 'charlie', occurredAt: 100 }),
      createEvent({ id: 'bravo', occurredAt: 100 }),
      createEvent({ id: 'older', occurredAt: 90 }),
    ]) {
      await repository.insert(event);
    }

    await expect(repository.page({ limit: 2 })).resolves.toEqual([
      expect.objectContaining({ id: 'charlie' }),
      expect.objectContaining({ id: 'bravo' }),
    ]);
    await expect(
      repository.page({ limit: 10, beforeOccurredAt: 100 }),
    ).resolves.toEqual([expect.objectContaining({ id: 'older' })]);
  });

  it('caps page size at 100', async () => {
    const database = createDatabase();
    const repository = new EventRepository(database);

    for (let index = 0; index < 120; index += 1) {
      await repository.insert(
        createEvent({
          id: `event-${index}`,
          occurredAt: 1_000 - index,
        }),
      );
    }

    const page = await repository.page({ limit: 999 });

    expect(page).toHaveLength(100);
  });
});

describe('MetricRepository', () => {
  it('returns only fresh records and replaces stale ones with puts', async () => {
    const database = createDatabase();
    const repository = new MetricRepository(database.metrics);
    const stale = createMetricRecord({
      traderId: 'trader-1',
      expiresAt: 100,
      fetchedAt: 10,
    });
    const fresh = createMetricRecord({
      traderId: 'trader-1',
      expiresAt: 500,
      fetchedAt: 400,
      followers: 123,
    });

    await repository.put(stale);
    await expect(repository.getFresh('trader-1', 100)).resolves.toBeUndefined();

    await repository.put(fresh);
    await expect(repository.getFresh('trader-1', 499)).resolves.toEqual(
      expect.objectContaining({
        traderId: 'trader-1',
        expiresAt: 500,
        followers: 123,
      }),
    );
  });

  it('rejects invalid freshness and malformed metric records', async () => {
    const database = createDatabase();
    const repository = new MetricRepository(database.metrics);

    await expect(repository.getFresh('trader-1', Number.NaN)).rejects.toThrowError(
      'now must be a finite number',
    );
    await expect(
      repository.put(
        createMetricRecord({
          traderId: 'trader-1',
          expiresAt: Number.POSITIVE_INFINITY,
        }),
      ),
    ).rejects.toThrowError('fetchedAt and expiresAt must be finite non-negative integers');
    await expect(
      repository.put(
        createMetricRecord({
          traderId: 'trader-1',
          fetchedAt: -1,
          expiresAt: 100,
        }),
      ),
    ).rejects.toThrowError('fetchedAt and expiresAt must be finite non-negative integers');
    await expect(
      repository.put(
        createMetricRecord({
          traderId: 'trader-1',
          fetchedAt: 100,
          expiresAt: 100,
        }),
      ),
    ).rejects.toThrowError('expiresAt must be greater than fetchedAt');
  });
});
