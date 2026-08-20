import { describe, expect, it } from 'vitest';

import {
  PIPELINE_HEALTH_STORAGE_KEY,
  PipelineHealthState,
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
