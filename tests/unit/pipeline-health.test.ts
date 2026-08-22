import { describe, expect, it } from 'vitest';

import { ACTIVITY_REJECTION_STAGES } from '../../src/background/diagnostics';
import {
  PIPELINE_HEALTH_STORAGE_KEY,
  PipelineHealthState,
  PersistedPipelineHealth,
  UNKNOWN_NETWORK_AGGREGATE_LIMIT,
  parsePipelineHealthSnapshot,
  pipelineHealthEventSchema,
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
      schemaRejections: 0,
      storageFailures: 0,
      broadcastFailures: 0,
      persisted: 0,
      broadcasts: 0,
      rejectionStages: {},
      unknownNetworkAggregates: [],
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
        ...(code === 'schema_invalid' ? { schemaRejections: 1 } : {}),
        ...(code === 'storage_failed' ? { storageFailures: 1 } : {}),
        ...(code === 'broadcast_failed' ? { broadcastFailures: 1 } : {}),
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

  it.each(ACTIVITY_REJECTION_STAGES)(
    'records the closed rejection stage %s with a counter and timestamp',
    (stage) => {
      const health = new PipelineHealthState(() => 1_000);

      health.record({ type: 'activity.rejectionStage', stage, at: 2_000 });

      expect(health.snapshot()).toMatchObject({
        rejected: 1,
        rejectionStages: { [stage]: 1 },
        lastRejectionStage: stage,
        lastRejectedAt: 2_000,
      });
    },
  );

  it('derives the legacy coarse counters and stage counters from code-based rejections', () => {
    const health = new PipelineHealthState(() => 1_000);

    health.record({ type: 'activity.rejected', code: 'schema_invalid', at: 2_000 });
    health.record({ type: 'activity.rejected', code: 'duplicate', at: 2_001 });
    health.record({ type: 'activity.rejected', code: 'storage_failed', at: 2_002 });
    health.record({ type: 'activity.rejected', code: 'broadcast_failed', at: 2_003 });

    expect(health.snapshot()).toMatchObject({
      rejected: 4,
      schemaRejections: 1,
      duplicates: 1,
      storageFailures: 1,
      broadcastFailures: 1,
      rejectionStages: {
        'raw-schema': 1,
        deduplication: 1,
        storage: 1,
        broadcast: 1,
      },
    });
  });

  it('saturates rejection stage counters at MAX_SAFE_INTEGER', () => {
    const health = new PipelineHealthState(() => 1_000, {
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
      rejectionStages: { 'raw-schema': Number.MAX_SAFE_INTEGER },
    });

    health.record({ type: 'activity.rejectionStage', stage: 'raw-schema', at: 2_000 });

    expect(health.snapshot().rejectionStages?.['raw-schema']).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('PipelineHealthState unknown network aggregates', () => {
  it('increments an existing network aggregate and refreshes lastSeenAt', () => {
    const health = new PipelineHealthState(() => 1_000);

    health.record({ type: 'activity.unknownNetwork', networkId: 900001, at: 2_000 });
    health.record({ type: 'activity.unknownNetwork', networkId: 900001, at: 3_000 });

    expect(health.snapshot().unknownNetworkAggregates).toEqual([
      { networkId: 900001, count: 2, lastSeenAt: 3_000 },
    ]);
  });

  it('keeps lastSeenAt at the maximum when events arrive out of order', () => {
    const health = new PipelineHealthState(() => 1_000);

    health.record({ type: 'activity.unknownNetwork', networkId: 900001, at: 3_000 });
    health.record({ type: 'activity.unknownNetwork', networkId: 900001, at: 2_000 });

    expect(health.snapshot().unknownNetworkAggregates?.[0]?.lastSeenAt).toBe(3_000);
  });

  it('caps the aggregate at 20 network IDs, evicting the least recently seen', () => {
    const health = new PipelineHealthState(() => 1_000);

    for (let id = 1; id <= 20; id += 1) {
      health.record({
        type: 'activity.unknownNetwork',
        networkId: 900000 + id,
        at: 1_000 + id,
      });
    }

    // A 21st distinct ID evicts the aggregate with the oldest lastSeenAt.
    health.record({ type: 'activity.unknownNetwork', networkId: 950000, at: 1_100 });

    const aggregates = health.snapshot().unknownNetworkAggregates ?? [];

    expect(aggregates).toHaveLength(UNKNOWN_NETWORK_AGGREGATE_LIMIT);
    expect(aggregates.some((entry) => entry.networkId === 900001)).toBe(false);
    expect(aggregates.some((entry) => entry.networkId === 950000)).toBe(true);
  });

  it('saturates an aggregate count at MAX_SAFE_INTEGER', () => {
    const health = new PipelineHealthState(() => 1_000, {
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
      unknownNetworkAggregates: [
        { networkId: 900001, count: Number.MAX_SAFE_INTEGER, lastSeenAt: 1_000 },
      ],
    });

    health.record({ type: 'activity.unknownNetwork', networkId: 900001, at: 2_000 });

    expect(health.snapshot().unknownNetworkAggregates).toEqual([
      { networkId: 900001, count: Number.MAX_SAFE_INTEGER, lastSeenAt: 2_000 },
    ]);
  });
});

describe('PipelineHealthState activity recovery (Task 4)', () => {
  it('adds the reported count to the recovered counter', () => {
    const health = new PipelineHealthState(() => 1_000);

    health.record({ type: 'activity.recovered', at: 2_000, count: 3 });
    health.record({ type: 'activity.recovered', at: 2_100, count: 2 });

    expect(health.snapshot().recovered).toBe(5);
  });

  it('leaves the counter absent for a completed run that found nothing new', () => {
    const health = new PipelineHealthState(() => 1_000);

    health.record({ type: 'activity.recovered', at: 2_000, count: 0 });

    expect(health.snapshot().recovered).toBeUndefined();
  });

  it('saturates the recovered counter at MAX_SAFE_INTEGER', () => {
    const health = new PipelineHealthState(() => 1_000, {
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
      recovered: Number.MAX_SAFE_INTEGER,
    });

    health.record({ type: 'activity.recovered', at: 2_000, count: 2 });

    expect(health.snapshot().recovered).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('accepts only the closed activity.recovered payload shape', () => {
    expect(
      pipelineHealthEventSchema.safeParse({ type: 'activity.recovered', at: 1_000, count: 2 }).success,
    ).toBe(true);
    expect(
      pipelineHealthEventSchema.safeParse({ type: 'activity.recovered', at: 1_000, count: 0 }).success,
    ).toBe(true);

    for (const payload of [
      { type: 'activity.recovered', at: 1_000 },
      { type: 'activity.recovered', at: 1_000, count: -1 },
      { type: 'activity.recovered', at: 1_000, count: 1.5 },
      { type: 'activity.recovered', at: 1_000, count: 2, extra: 1 },
    ]) {
      expect(pipelineHealthEventSchema.safeParse(payload).success).toBe(false);
    }
  });

  it('parses the optional recovered counter in a snapshot and rejects malformed values', () => {
    const valid = new PipelineHealthState(() => 1_000).snapshot();

    expect(parsePipelineHealthSnapshot({ ...valid, recovered: 3 })).toMatchObject({
      recovered: 3,
    });
    expect(parsePipelineHealthSnapshot(valid)).toMatchObject({});
    expect(parsePipelineHealthSnapshot({ ...valid, recovered: -1 })).toBeUndefined();
    expect(parsePipelineHealthSnapshot({ ...valid, recovered: 1.5 })).toBeUndefined();
    expect(
      parsePipelineHealthSnapshot({ ...valid, recovered: Number.MAX_SAFE_INTEGER + 1 }),
    ).toBeUndefined();
  });
});

describe('pipeline health snapshot schema for bounded evidence', () => {
  it('rejects identity, address, amount, opinion, URL, and raw-payload keys in stage aggregates', () => {
    const valid = new PipelineHealthState(() => 1_000).snapshot();

    for (const key of [
      'id',
      'userId',
      'tokenAddress',
      'usdAmount',
      'thesis',
      'https://evil.example/x',
      'rawPayload',
      'cookie',
    ]) {
      expect(
        parsePipelineHealthSnapshot({
          ...valid,
          rejectionStages: { ...valid.rejectionStages, [key]: 1 },
        }),
      ).toBeUndefined();
    }
  });

  it('rejects hostile or malformed unknown-network aggregate entries', () => {
    const valid = new PipelineHealthState(() => 1_000).snapshot();

    for (const aggregates of [
      // Extra sensitive fields on an otherwise valid entry.
      [{ networkId: 900001, count: 1, lastSeenAt: 1_000, tokenAddress: '0x0' }],
      [{ networkId: 900001, count: 1, lastSeenAt: 1_000, userId: 'trader-1' }],
      [{ networkId: 900001, count: 1, lastSeenAt: 1_000, thesis: 'secret' }],
      [{ networkId: 900001, count: 1, lastSeenAt: 1_000, rawPayload: {} }],
      [{ networkId: 900001, count: 1, lastSeenAt: 1_000, url: 'https://evil.example' }],
      // Non-numeric or out-of-range identifiers.
      [{ networkId: '900001', count: 1, lastSeenAt: 1_000 }],
      [{ networkId: -1, count: 1, lastSeenAt: 1_000 }],
      [{ networkId: 1.5, count: 1, lastSeenAt: 1_000 }],
      // Malformed counters and timestamps.
      [{ networkId: 900001, count: -1, lastSeenAt: 1_000 }],
      [{ networkId: 900001, count: Number.MAX_SAFE_INTEGER + 1, lastSeenAt: 1_000 }],
      [{ networkId: 900001, count: 1.5, lastSeenAt: 1_000 }],
      [{ networkId: 900001, count: 1, lastSeenAt: -1 }],
      [{ networkId: 900001, count: 1, lastSeenAt: Number.NaN }],
      [{ networkId: 900001, count: 1, lastSeenAt: 1.5 }],
      // More than the 20-ID cap.
      Array.from({ length: 21 }, (_, index) => ({
        networkId: 900000 + index,
        count: 1,
        lastSeenAt: 1_000 + index,
      })),
    ]) {
      expect(
        parsePipelineHealthSnapshot({ ...valid, unknownNetworkAggregates: aggregates }),
      ).toBeUndefined();
    }
  });

  it('rejects hostile rejection-stage names anywhere in the snapshot', () => {
    const valid = new PipelineHealthState(() => 1_000).snapshot();

    expect(
      parsePipelineHealthSnapshot({ ...valid, lastRejectionStage: 'tokenAddress' }),
    ).toBeUndefined();
    expect(
      parsePipelineHealthSnapshot({ ...valid, rejectionStages: { userId: 2 } }),
    ).toBeUndefined();
  });
});

describe('PersistedPipelineHealth', () => {
  it('drains a record queued after set resolves but before the owner finally clears', async () => {
    let resolveSet!: () => void;
    const deferredSet = new Promise<void>((resolve) => {
      resolveSet = resolve;
    });
    let notifySetStarted!: () => void;
    const setStarted = new Promise<void>((resolve) => {
      notifySetStarted = resolve;
    });
    const writes: Record<string, unknown>[] = [];
    const projection = new PersistedPipelineHealth({
      storage: {
        get: async () => ({}),
        set: async (items) => {
          writes.push(items);
          notifySetStarted();
          if (writes.length === 1) await deferredSet;
        },
      },
      now: () => 1_000,
      onStorageFailure: () => {},
    });

    const first = projection.record({ type: 'activity.candidate', at: 1_000 });
    await setStarted;
    expect(writes).toHaveLength(1);

    const second = deferredSet.then(() =>
      projection.record({ type: 'activity.candidate', at: 2_000 }),
    );
    resolveSet();
    await Promise.all([first, second]);

    expect(writes).toHaveLength(2);
    expect(writes[1]?.[PIPELINE_HEALTH_STORAGE_KEY]).toMatchObject({
      activityCandidates: 2,
      lastCandidateAt: 2_000,
    });
  });

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
