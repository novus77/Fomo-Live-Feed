import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import type { TradeEventV1 } from '../../src/domain/activity';
import { FomoFeedDatabase } from '../../src/storage/database';
import { EventRepository } from '../../src/storage/event-repository';
import { runRetention } from '../../src/background/retention';

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
  traderId: overrides.traderId ?? 'retention-trader',
  traderHandle: overrides.traderHandle ?? 'keeper',
  chain: overrides.chain ?? 'solana',
  tokenAddress: overrides.tokenAddress ?? 'token-retention',
  tokenSymbol: overrides.tokenSymbol ?? 'RET',
  action: overrides.action ?? 'buy',
  occurredAt: overrides.occurredAt,
  receivedAt: overrides.receivedAt ?? overrides.occurredAt + 1,
  ...(overrides.readAt === undefined ? {} : { readAt: overrides.readAt }),
});

afterEach(async () => {
  await Promise.all(
    openDatabases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe('runRetention', () => {
  it('deletes events strictly older than the age cutoff and keeps the boundary event', async () => {
    const database = createDatabase();
    const repository = new EventRepository(database, database.events);
    const now = 1_000;
    const maxAgeMs = 100;

    for (const event of [
      createEvent({ id: 'old', occurredAt: 899 }),
      createEvent({ id: 'boundary', occurredAt: 900 }),
      createEvent({ id: 'fresh', occurredAt: 950 }),
    ]) {
      await repository.insert(event);
    }

    await expect(
      runRetention(database, { now, maxAgeMs, maxEvents: 99, batchSize: 10 }),
    ).resolves.toEqual({
      deletedByAge: 1,
      deletedByCount: 0,
      totalDeleted: 1,
    });

    await expect(repository.get('old')).resolves.toBeUndefined();
    await expect(repository.get('boundary')).resolves.toEqual(
      expect.objectContaining({ id: 'boundary' }),
    );
    await expect(repository.get('fresh')).resolves.toEqual(
      expect.objectContaining({ id: 'fresh' }),
    );
  });

  it('deletes the oldest overflow rows when the count exceeds maxEvents', async () => {
    const database = createDatabase();
    const repository = new EventRepository(database, database.events);

    for (const event of [
      createEvent({ id: 'one', occurredAt: 100 }),
      createEvent({ id: 'two', occurredAt: 200 }),
      createEvent({ id: 'three', occurredAt: 300 }),
    ]) {
      await repository.insert(event);
    }

    await expect(
      runRetention(database, {
        now: 1_000,
        maxAgeMs: 10_000,
        maxEvents: 2,
        batchSize: 10,
      }),
    ).resolves.toEqual({
      deletedByAge: 0,
      deletedByCount: 1,
      totalDeleted: 1,
    });

    await expect(repository.get('one')).resolves.toBeUndefined();
    await expect(repository.page({ limit: 10 })).resolves.toEqual([
      expect.objectContaining({ id: 'three' }),
      expect.objectContaining({ id: 'two' }),
    ]);
  });

  it('spends the batch budget on expired rows first and then uses any remaining budget for overflow cleanup', async () => {
    const database = createDatabase();
    const repository = new EventRepository(database, database.events);

    for (let index = 0; index < 600; index += 1) {
      await repository.insert(
        createEvent({
          id: `event-${index}`,
          occurredAt: index < 400 ? index : 10_000 + index,
        }),
      );
    }

    const result = await runRetention(database, {
      now: 1_000,
      maxAgeMs: 500,
      maxEvents: 50,
      batchSize: 500,
    });

    expect(result).toEqual({
      deletedByAge: 400,
      deletedByCount: 100,
      totalDeleted: 500,
    });
    await expect(repository.page({ limit: 100 })).resolves.toHaveLength(100);
  });

  it('uses remaining batch budget for overflow cleanup after expired rows are removed', async () => {
    const database = createDatabase();
    const repository = new EventRepository(database, database.events);

    for (const event of [
      createEvent({ id: 'expired-1', occurredAt: 100 }),
      createEvent({ id: 'expired-2', occurredAt: 200 }),
      createEvent({ id: 'keep-1', occurredAt: 800 }),
      createEvent({ id: 'keep-2', occurredAt: 900 }),
      createEvent({ id: 'keep-3', occurredAt: 1_000 }),
    ]) {
      await repository.insert(event);
    }

    await expect(
      runRetention(database, {
        now: 1_000,
        maxAgeMs: 500,
        maxEvents: 2,
        batchSize: 3,
      }),
    ).resolves.toEqual({
      deletedByAge: 2,
      deletedByCount: 1,
      totalDeleted: 3,
    });

    await expect(repository.page({ limit: 10 })).resolves.toEqual([
      expect.objectContaining({ id: 'keep-3' }),
      expect.objectContaining({ id: 'keep-2' }),
    ]);
  });
});
