import { describe, expect, it, vi } from 'vitest';

import {
  openFomoToken,
  selectFomoTab,
  type TokenNavigationChrome,
} from '../../src/background/fomo-tab-navigation';

const ADDRESS = '0x020BFC650A365F8bB26819DeAaBF3E21291018B4';

describe('selectFomoTab', () => {
  it('prefers the newest valid tab in the current window', () => {
    expect(selectFomoTab([
      { id: 7, windowId: 2, lastAccessed: 999 },
      { id: 4, windowId: 1, lastAccessed: 10 },
      { id: 3, windowId: 1, lastAccessed: 20 },
    ], 1)?.id).toBe(3);
  });

  it('uses newest other-window tab, zero for missing access, and ascending id ties', () => {
    expect(selectFomoTab([
      { windowId: 1, lastAccessed: 100 },
      { id: 8, windowId: 2 },
      { id: 2, windowId: 3 },
    ], 1)?.id).toBe(2);
    expect(selectFomoTab([], 1)).toBeUndefined();
  });
});

function chromeWith(tabs: Array<{ id?: number; windowId: number; lastAccessed?: number }>) {
  const api: TokenNavigationChrome = {
    tabs: {
      query: vi.fn().mockResolvedValue(tabs),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
    },
    windows: {
      getLastFocused: vi.fn().mockResolvedValue({ id: 1 }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  return api;
}

describe('openFomoToken', () => {
  it('queries only fixed Fomo origins, updates the selected tab, and focuses its window', async () => {
    const api = chromeWith([{ id: 9, windowId: 2, lastAccessed: 1 }]);
    await expect(openFomoToken(api, { chain: 'bsc', tokenAddress: ADDRESS })).resolves.toEqual({ ok: true });
    expect(api.tabs.query).toHaveBeenCalledWith({ url: [
      'https://fomo.family/*',
      'https://www.fomo.family/*',
    ] });
    expect(api.tabs.update).toHaveBeenCalledWith(9, {
      url: 'https://fomo.family/tokens/bnb/0x020bfc650a365f8bb26819deaabf3e21291018b4',
      active: true,
    });
    expect(api.windows.update).toHaveBeenCalledWith(2, { focused: true });
  });

  it('creates an active tab when no candidate exists', async () => {
    const api = chromeWith([]);
    await expect(openFomoToken(api, { chain: 'base', tokenAddress: ADDRESS })).resolves.toEqual({ ok: true });
    expect(api.tabs.create).toHaveBeenCalledOnce();
  });

  it('falls back to create once after update failure', async () => {
    const api = chromeWith([{ id: 9, windowId: 2 }]);
    vi.mocked(api.tabs.update).mockRejectedValueOnce(new Error('gone'));
    await expect(openFomoToken(api, { chain: 'bsc', tokenAddress: ADDRESS })).resolves.toEqual({ ok: true });
    expect(api.tabs.create).toHaveBeenCalledOnce();
  });

  it('does not duplicate an already-updated tab when focusing its window fails', async () => {
    const api = chromeWith([{ id: 9, windowId: 2 }]);
    vi.mocked(api.windows.update).mockRejectedValueOnce(new Error('focus failed'));
    await expect(openFomoToken(api, { chain: 'bsc', tokenAddress: ADDRESS }))
      .resolves.toEqual({ ok: false, reason: 'chrome-api-failed' });
    expect(api.tabs.create).not.toHaveBeenCalled();
  });

  it('returns closed failure reasons without calling Chrome for invalid targets', async () => {
    const api = chromeWith([]);
    await expect(openFomoToken(api, { chain: 'ethereum', tokenAddress: ADDRESS })).resolves.toEqual({ ok: false, reason: 'invalid-target' });
    expect(api.tabs.query).not.toHaveBeenCalled();
    vi.mocked(api.tabs.query).mockRejectedValueOnce(new Error('private'));
    await expect(openFomoToken(api, { chain: 'bsc', tokenAddress: ADDRESS })).resolves.toEqual({ ok: false, reason: 'chrome-api-failed' });
  });
});
