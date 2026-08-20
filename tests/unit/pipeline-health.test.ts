import { describe, expect, it } from 'vitest';

import {
  PIPELINE_HEALTH_STORAGE_KEY,
  PipelineHealthState,
  PersistedPipelineHealth,
  parsePipelineHealthSnapshot,
} from '../../src/background/pipeline-health';

describe('PipelineHealthState', () => {
  it('starts with a closed, empty snapshot', () => {
    expect(new PipelineHealthState(() => 1_000).snapshot()).toEqual({
      schemaVersion: 1,
      observerInstalled: false,
      socketObserved: false,
      socketOpen: false,
      activityCandidates: 0,
      accepted: 0,
      rejected: 0,
      duplicates: 0,
      persisted: 0,
      broadcasts: 0,
    });
  });

  it('updates timestamps and monotonically saturates counters', () => {
    const health = new PipelineHealthState(() => 9_000, {
      schemaVersion: 1,
      observerInstalled: false,
      socketObserved: false,
      socketOpen: false,
      activityCandidates: Number.MAX_SAFE_INTEGER,
      accepted: 0,
      rejected: 0,
      duplicates: 0,
      persisted: 0,
      broadcasts: 0,
    });

    health.record({ type: 'observer.installed' });
    health.record({ type: 'socket.observed', at: 1_000 });
    health.record({ type: 'socket.opened', at: 1_100 });
    health.record({ type: 'frame.received', at: 1_200 });
    health.record({ type: 'activity.candidate', at: 1_300 });
    health.record({ type: 'activity.accepted', at: 1_400, occurredAt: 900 });
    health.record({ type: 'activity.persisted', at: 1_500 });
    health.record({ type: 'activity.broadcast', at: 1_600 });
    health.record({ type: 'socket.closed', at: 1_700 });

    expect(health.snapshot()).toMatchObject({
      observerInstalled: true,
      socketObserved: true,
      socketOpen: false,
      lastFrameAt: 1_200,
      lastCandidateAt: 1_300,
      lastPersistedAt: 1_500,
      latestEventOccurredAt: 900,
      activityCandidates: Number.MAX_SAFE_INTEGER,
      accepted: 1,
      persisted: 1,
      broadcasts: 1,
    });
  });

  it('keeps latestEventOccurredAt at the maximum for out-of-order accepted events', () => {
    const health = new PipelineHealthState(() => 1_000);
    health.record({ type: 'activity.accepted', at: 2_000, occurredAt: 1_900 });
    health.record({ type: 'activity.accepted', at: 2_100, occurredAt: 1_500 });

    expect(health.snapshot().latestEventOccurredAt).toBe(1_900);
  });

  it.each(['schema_invalid', 'duplicate', 'storage_failed', 'broadcast_failed'] as const)(
    'records the closed rejection code %s',
    (code) => {
      const health = new PipelineHealthState(() => 1_000);
      health.record({ type: 'activity.rejected', code, at: 2_000 });

      expect(health.snapshot()).toMatchObject({
        rejected: 1,
        ...(code === 'duplicate' ? { duplicates: 1 } : {}),
        lastRejectionCode: code,
        lastRejectedAt: 2_000,
      });
    },
  );

  it('serializes a defensive, JSON-safe snapshot under the versioned key', () => {
    const health = new PipelineHealthState(() => 1_000);
    health.record({ type: 'activity.candidate', at: 2_000 });

    const snapshot = health.snapshot();
    expect(PIPELINE_HEALTH_STORAGE_KEY).toBe('pipelineHealth.v1');
    expect(parsePipelineHealthSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
  });

  it('rejects malformed session state and every extra or sensitive key', () => {
    const valid = new PipelineHealthState(() => 1_000).snapshot();

    for (const malformed of [
      null,
      { ...valid, accepted: -1 },
      { ...valid, accepted: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, lastFrameAt: Number.NaN },
      { ...valid, lastFrameAt: 1.5 },
      ...['payload', 'cookie', 'tokenAddress', 'thesis', 'url', 'headers'].map((key) => ({
        ...valid,
        [key]: 'secret',
      })),
    ]) {
      expect(parsePipelineHealthSnapshot(malformed)).toBeUndefined();
    }
  });
});

describe('PersistedPipelineHealth', () => {
  it('keeps record pending through storage.set and coalesces a burst to the latest snapshot', async () => {
    let resolveFirstSet!: () => void;
    const firstSet = new Promise<void>((resolve) => {
      resolveFirstSet = resolve;
    });
    const writes: Record<string, unknown>[] = [];
    const projection = new PersistedPipelineHealth({
      storage: {
        get: async () => ({}),
        set: async (items) => {
          writes.push(items);
          if (writes.length === 1) await firstSet;
        },
      },
      now: () => 1_000,
      onStorageFailure: () => {},
    });

    const first = projection.record({ type: 'activity.candidate', at: 1_000 });
    await Promise.resolve();
    await Promise.resolve();
    let firstSettled = false;
    void first.then(() => { firstSettled = true; });
    await Promise.resolve();
    expect(firstSettled).toBe(false);

    const second = projection.record({ type: 'activity.candidate', at: 2_000 });
    const third = projection.record({ type: 'activity.candidate', at: 3_000 });
    resolveFirstSet();
    await Promise.all([first, second, third]);

    expect(writes).toHaveLength(2);
    expect(writes[1]?.[PIPELINE_HEALTH_STORAGE_KEY]).toMatchObject({
      activityCandidates: 3,
      lastCandidateAt: 3_000,
    });
  });

  it('waits for deferred restoration before applying events or answering queries', async () => {
    let resolveGet!: (value: Record<string, unknown>) => void;
    const get = new Promise<Record<string, unknown>>((resolve) => {
      resolveGet = resolve;
    });
    const writes: Record<string, unknown>[] = [];
    const projection = new PersistedPipelineHealth({
      storage: {
        get: async () => get,
        set: async (items) => { writes.push(items); },
      },
      now: () => 1_000,
      onStorageFailure: () => {},
    });

    const event = projection.record({ type: 'activity.candidate', at: 2_000 });
    const query = projection.snapshot();
    let settled = false;
    void query.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    resolveGet({
      [PIPELINE_HEALTH_STORAGE_KEY]: {
        schemaVersion: 1,
        observerInstalled: true,
        socketObserved: false,
        socketOpen: false,
        activityCandidates: 4,
        accepted: 0,
        rejected: 0,
        duplicates: 0,
        persisted: 0,
        broadcasts: 0,
      },
    });
    await event;
    await projection.flush();

    expect(await query).toMatchObject({ observerInstalled: true, activityCandidates: 5 });
    expect(writes.at(-1)?.[PIPELINE_HEALTH_STORAGE_KEY]).toMatchObject({
      activityCandidates: 5,
    });
  });

  it('reports a rejected write without changing business counters and keeps later writes fresh', async () => {
    const writes: Record<string, unknown>[] = [];
    const failures: unknown[] = [];
    let attempts = 0;
    const projection = new PersistedPipelineHealth({
      storage: {
        get: async () => ({}),
        set: async (items) => {
          attempts += 1;
          if (attempts === 1) throw new Error('session unavailable');
          writes.push(items);
        },
      },
      now: () => 1_000,
      onStorageFailure: (error) => { failures.push(error); },
    });

    await projection.record({ type: 'activity.candidate', at: 2_000 });
    await projection.record({ type: 'activity.candidate', at: 3_000 });
    await projection.flush();

    expect(failures).toHaveLength(1);
    expect(await projection.snapshot()).toMatchObject({
      activityCandidates: 2,
      rejected: 0,
      lastCandidateAt: 3_000,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.[PIPELINE_HEALTH_STORAGE_KEY]).toMatchObject({
      activityCandidates: 2,
      lastCandidateAt: 3_000,
    });
  });
});
