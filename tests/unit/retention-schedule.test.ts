import { describe, expect, it } from 'vitest';

import type { SessionStorageLike } from '../../src/background/connection-state';
import { DiagnosticRecorder } from '../../src/background/diagnostics';
import {
  DEFAULT_RETENTION_INTERVAL_MS,
  isRetentionDue,
  LAST_RETENTION_STORAGE_KEY,
  readLastRetentionAt,
  RetentionScheduler,
  writeLastRetentionAt,
} from '../../src/background/retention-schedule';

const NOW = 1_800_000_000_000;

const createStorageFake = (initial: Record<string, unknown> = {}) => {
  const records: Record<string, unknown> = { ...initial };
  const get = async (keys: string[]): Promise<Record<string, unknown>> => {
    const result: Record<string, unknown> = {};

    for (const key of keys) {
      if (key in records) {
        result[key] = records[key];
      }
    }

    return result;
  };
  const set = async (items: Record<string, unknown>): Promise<void> => {
    Object.assign(records, items);
  };

  return { records, storage: { get, set } as SessionStorageLike };
};

const emptyResult = { deletedByAge: 0, deletedByCount: 0, totalDeleted: 0 };

describe('retention schedule helpers', () => {
  it('is due when no timestamp was ever stored (a fresh worker)', () => {
    expect(isRetentionDue(undefined, NOW, DEFAULT_RETENTION_INTERVAL_MS)).toBe(true);
  });

  it('is not due while the last run is recent', () => {
    expect(isRetentionDue(NOW - 60_000, NOW, DEFAULT_RETENTION_INTERVAL_MS)).toBe(false);
    expect(isRetentionDue(NOW - 1, NOW, DEFAULT_RETENTION_INTERVAL_MS)).toBe(false);
  });

  it('is due again once a full interval has elapsed since the last run', () => {
    expect(
      isRetentionDue(NOW - DEFAULT_RETENTION_INTERVAL_MS, NOW, DEFAULT_RETENTION_INTERVAL_MS),
    ).toBe(true);
    expect(
      isRetentionDue(NOW - DEFAULT_RETENTION_INTERVAL_MS - 1, NOW, DEFAULT_RETENTION_INTERVAL_MS),
    ).toBe(true);
  });

  it('reads back a persisted run timestamp', async () => {
    const { storage } = createStorageFake({ [LAST_RETENTION_STORAGE_KEY]: NOW - 3_600_000 });

    await expect(readLastRetentionAt(storage)).resolves.toBe(NOW - 3_600_000);
  });

  it.each([['not-a-number'], [-1], [1.5], [Number.NaN], [null], [undefined]])(
    'treats an invalid persisted value %p as absent',
    async (value) => {
      const { storage } = createStorageFake({ [LAST_RETENTION_STORAGE_KEY]: value });

      await expect(readLastRetentionAt(storage)).resolves.toBeUndefined();
    },
  );

  it('writes the run timestamp under the session storage key', async () => {
    const { records, storage } = createStorageFake();

    await writeLastRetentionAt(storage, NOW);

    expect(records[LAST_RETENTION_STORAGE_KEY]).toBe(NOW);
  });

  it('rejects an invalid write timestamp', async () => {
    const { storage } = createStorageFake();

    await expect(writeLastRetentionAt(storage, -1)).rejects.toThrowError(TypeError);
    await expect(writeLastRetentionAt(storage, 1.5)).rejects.toThrowError(TypeError);
  });
});

describe('RetentionScheduler', () => {
  const createScheduler = (
    storage: SessionStorageLike,
    runs: number[],
    options: { runRejects?: boolean; now?: number; diagnostics?: DiagnosticRecorder } = {},
  ) => {
    const now = options.now ?? NOW;
    const scheduler = new RetentionScheduler({
      storage,
      now: () => now,
      runRetentionFn: async (at: number) => {
        if (options.runRejects === true) {
          throw new Error('indexeddb exploded');
        }

        runs.push(at);
        return emptyResult;
      },
      diagnostics: options.diagnostics ?? new DiagnosticRecorder({ now: () => now }),
    });

    return scheduler;
  };

  it('runs retention on startup when no timestamp is stored', async () => {
    const { records, storage } = createStorageFake();
    const runs: number[] = [];
    const scheduler = createScheduler(storage, runs);

    await scheduler.seed();
    await scheduler.maybeRun();

    expect(runs).toEqual([NOW]);
    expect(records[LAST_RETENTION_STORAGE_KEY]).toBe(NOW);
  });

  it('skips retention when the last run is recent', async () => {
    const { records, storage } = createStorageFake({
      [LAST_RETENTION_STORAGE_KEY]: NOW - 60_000,
    });
    const runs: number[] = [];
    const scheduler = createScheduler(storage, runs);

    await scheduler.seed();
    await scheduler.maybeRun();

    expect(runs).toEqual([]);
    expect(records[LAST_RETENTION_STORAGE_KEY]).toBe(NOW - 60_000);
  });

  it('runs retention again when the last run was a full interval ago', async () => {
    const { records, storage } = createStorageFake({
      [LAST_RETENTION_STORAGE_KEY]: NOW - DEFAULT_RETENTION_INTERVAL_MS,
    });
    const runs: number[] = [];
    const scheduler = createScheduler(storage, runs);

    await scheduler.seed();
    await scheduler.maybeRun();

    expect(runs).toEqual([NOW]);
    expect(records[LAST_RETENTION_STORAGE_KEY]).toBe(NOW);
  });

  it('a fresh worker seeded from a just-completed run skips the next run', async () => {
    const { storage } = createStorageFake({
      [LAST_RETENTION_STORAGE_KEY]: NOW - 1,
    });
    const runs: number[] = [];
    const scheduler = createScheduler(storage, runs, { now: NOW });

    await scheduler.seed();
    await scheduler.maybeRun();

    expect(runs).toEqual([]);
  });

  it('records a storage_failure diagnostic and keeps the schedule un-armed when retention throws', async () => {
    const { records, storage } = createStorageFake();
    const runs: number[] = [];
    const diagnostics = new DiagnosticRecorder({ now: () => NOW });
    const scheduler = createScheduler(storage, runs, {
      runRejects: true,
      diagnostics,
    });

    await scheduler.seed();
    await scheduler.maybeRun();

    expect(runs).toEqual([]);
    expect(records[LAST_RETENTION_STORAGE_KEY]).toBeUndefined();
    expect(diagnostics.snapshot()).toEqual([
      { code: 'storage_failure', receivedAt: NOW, messageType: 'retention' },
    ]);
  });

  it('rejects an invalid interval at construction', () => {
    const { storage } = createStorageFake();

    expect(
      () =>
        new RetentionScheduler({
          storage,
          now: () => NOW,
          runRetentionFn: async () => emptyResult,
          diagnostics: new DiagnosticRecorder({ now: () => NOW }),
          intervalMs: 0,
        }),
    ).toThrowError(TypeError);
  });
});
