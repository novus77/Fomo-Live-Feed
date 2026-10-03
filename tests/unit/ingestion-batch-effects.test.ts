import { describe, expect, it, vi } from 'vitest';

import { IngestionBatchEffects } from '../../src/background/ingestion-batch-effects';
import { PersistedPipelineHealth, PIPELINE_HEALTH_STORAGE_KEY } from '../../src/background/pipeline-health';

function fixture() {
  const set = vi.fn(async (_items: Record<string, unknown>) => {});
  const health = new PersistedPipelineHealth({
    storage: { get: async () => ({}), set }, now: () => 1_000, onStorageFailure: vi.fn(),
  });
  const notifyEvents = vi.fn(async () => {});
  const notifyHealth = vi.fn();
  const effects = new IngestionBatchEffects({ health, notifyEvents, notifyHealth });
  return { effects, health, set, notifyEvents, notifyHealth };
}

describe('IngestionBatchEffects', () => {
  it('records live counters but flushes a payload-less invalidation and health once', async () => {
    const { effects, health, set, notifyEvents, notifyHealth } = fixture();
    for (let index = 0; index < 100; index += 1) {
      await effects.record({ type: 'activity.persisted', at: 1_000 });
      effects.invalidateEvents();
      await effects.record({ type: 'activity.broadcast', at: 1_000 });
    }
    expect(await health.snapshot()).toMatchObject({ persisted: 100, broadcasts: 100 });
    expect(set).not.toHaveBeenCalled();
    expect(notifyEvents).not.toHaveBeenCalled();
    await effects.flush();
    expect(set).toHaveBeenCalledTimes(1);
    expect(notifyEvents.mock.calls).toEqual([[]]);
    expect(notifyHealth).toHaveBeenCalledTimes(1);
    await effects.flush();
    expect(set).toHaveBeenCalledTimes(1);
    expect(notifyEvents).toHaveBeenCalledTimes(1);
  });

  it('does nothing for an empty batch and does not invalidate duplicate-only work', async () => {
    const { effects, set, notifyEvents, notifyHealth } = fixture();
    await effects.flush();
    expect(set).not.toHaveBeenCalled();
    expect(notifyHealth).not.toHaveBeenCalled();
    await effects.record({ type: 'activity.rejected', code: 'duplicate', at: 1_000 });
    await effects.flush();
    expect(set).toHaveBeenCalledTimes(1);
    expect(notifyHealth).toHaveBeenCalledTimes(1);
    expect(notifyEvents).not.toHaveBeenCalled();
  });

  it('flushes health even if invalidation fails and retains invalidation for explicit retry', async () => {
    const { effects, set, notifyEvents, notifyHealth } = fixture();
    notifyEvents.mockRejectedValueOnce(new Error('failed invalidation'));
    effects.invalidateEvents();
    await effects.record({ type: 'activity.persisted', at: 1_000 });
    await expect(effects.flush()).rejects.toThrow('failed invalidation');
    expect(set).toHaveBeenCalledTimes(1);
    expect(notifyHealth).toHaveBeenCalledTimes(1);
    await effects.flush();
    expect(notifyEvents).toHaveBeenCalledTimes(2);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it('does not lose a new invalidation arriving while a flush is in flight', async () => {
    const { effects, health, notifyEvents, set } = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    notifyEvents.mockImplementationOnce(() => gate);
    effects.invalidateEvents();
    await effects.record({ type: 'activity.persisted', at: 1_000 });
    const first = effects.flush();
    await vi.waitFor(() => expect(notifyEvents).toHaveBeenCalledTimes(1));
    effects.invalidateEvents();
    await effects.record({ type: 'activity.persisted', at: 2_000 });
    const second = effects.flush();
    release();
    await Promise.all([first, second]);
    expect(notifyEvents).toHaveBeenCalledTimes(2);
    expect(await health.snapshot()).toMatchObject({ persisted: 2 });
    expect(set.mock.calls.at(-1)?.[0]?.[PIPELINE_HEALTH_STORAGE_KEY]).toMatchObject({ persisted: 2 });
  });

  it('starts a fresh owner for invalidation arriving after drain but before promise settlement', async () => {
    const { effects, notifyEvents } = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    notifyEvents.mockImplementationOnce(() => gate);
    effects.invalidateEvents();
    const first = effects.flush();
    await vi.waitFor(() => expect(notifyEvents).toHaveBeenCalledTimes(1));
    const second = gate.then(() => {
      effects.invalidateEvents();
      return effects.flush();
    });
    release();
    await Promise.all([first, second]);
    expect(notifyEvents).toHaveBeenCalledTimes(2);
  });
});
