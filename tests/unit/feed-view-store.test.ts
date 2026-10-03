import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_FILTERS } from '../../src/popup/event-query';
import { FeedViewStore, FEED_VIEW_STORAGE_KEY } from '../../src/sidepanel/feed-view-store';

function boundary() {
  const values: Record<string, unknown> = {};
  return {
    values,
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (items: Record<string, unknown>) => { Object.assign(values, items); }),
  };
}

describe('FeedViewStore', () => {
  it('preserves quick filters without persisting chain preferences or legacy search', async () => {
    const storage = boundary();
    const store = new FeedViewStore(storage);
    await store.save({ ...DEFAULT_FILTERS, source: 'pump', search: 'temporary', visibleChains: [],
      visibleActions: { buy: true, sell: false, thesis: false },
      minimumBuyAmount: 5, maximumBuyAmount: 100, minimumMarketCap: 20_000, maximumMarketCap: 500_000 });
    const next = await new FeedViewStore(storage).load();
    expect(next).toEqual({ source: 'pump', visibleActions: { buy: true, sell: false, thesis: false },
      minimumBuyAmount: 5, maximumBuyAmount: 100, minimumMarketCap: 20_000, maximumMarketCap: 500_000 });
    expect(storage.values[FEED_VIEW_STORAGE_KEY]).not.toHaveProperty('search');
    expect(storage.values[FEED_VIEW_STORAGE_KEY]).not.toHaveProperty('visibleChains');
  });

  it('waits for queued writes before hydrating a shared PiP feed', async () => {
    const storage = boundary();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    storage.set.mockImplementationOnce(async (items) => { await gate; Object.assign(storage.values, items); });
    const store = new FeedViewStore(storage);
    const first = store.save({ ...DEFAULT_FILTERS, source: 'fomo' });
    const second = store.save({ ...DEFAULT_FILTERS, source: 'pump' });
    const read = store.load();
    await Promise.resolve();
    expect(storage.get).not.toHaveBeenCalled();
    release();
    await Promise.all([first, second]);
    expect((await read)?.source).toBe('pump');
  });

  it('blocks handoff on a failed write and permits a later retry', async () => {
    const storage = boundary();
    storage.set.mockRejectedValueOnce(new Error('unavailable'));
    const store = new FeedViewStore(storage);
    await expect(store.save({ ...DEFAULT_FILTERS, source: 'pump' })).rejects.toThrow('unavailable');
    await expect(store.flush()).rejects.toThrow('unavailable');
    await store.save({ ...DEFAULT_FILTERS, source: 'fomo' });
    await expect(store.flush()).resolves.toBeUndefined();
    expect((await store.load())?.source).toBe('fomo');
  });

  it('discards malformed stored snapshots', async () => {
    const storage = boundary();
    const store = new FeedViewStore(storage);
    for (const value of [null, { schemaVersion: 9 }, { schemaVersion: 1, source: 'other' },
      { schemaVersion: 1, source: 'all', visibleActions: { buy: true, sell: true, thesis: true }, minimumBuyAmount: -1 }]) {
      storage.values[FEED_VIEW_STORAGE_KEY] = value;
      expect(await store.load()).toBeUndefined();
    }
  });
});
