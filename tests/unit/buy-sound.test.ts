import { describe, expect, it, vi } from 'vitest';

import { createLiveBuyNotifier } from '../../src/background/buy-sound';
import { DEFAULT_SETTINGS } from '../../src/domain/settings';
import type { TradeEventV1 } from '../../src/domain/activity';

const event = (action: TradeEventV1['action']): TradeEventV1 => ({
  schemaVersion: 1,
  id: `fomo:${action}`,
  source: 'fomo',
  traderId: 'trader-1',
  traderHandle: 'alpha',
  chain: 'unknown',
  tokenAddress: '0x0000000000000000000000000000000000000000',
  tokenSymbol: 'TKN',
  action,
  occurredAt: 1,
  receivedAt: 2,
});

const flush = async () => {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve();
  }
};

describe('createLiveBuyNotifier', () => {
  it('plays once for an enabled buy using the latest settings', async () => {
    const playBuy = vi.fn(async () => undefined);
    const getSettings = vi.fn(async () => ({
      ...DEFAULT_SETTINGS,
      notifications: { ...DEFAULT_SETTINGS.notifications, soundEnabled: true },
    }));
    const notifier = createLiveBuyNotifier({ preferences: { getSettings }, audio: { playBuy } });

    notifier.notify(event('buy'));
    await flush();

    expect(getSettings).toHaveBeenCalledOnce();
    expect(playBuy).toHaveBeenCalledOnce();
  });

  it('skips disabled buys and every non-buy action', async () => {
    const playBuy = vi.fn(async () => undefined);
    const getSettings = vi.fn(async () => DEFAULT_SETTINGS);
    const notifier = createLiveBuyNotifier({ preferences: { getSettings }, audio: { playBuy } });

    for (const action of ['buy', 'sell', 'thesis', 'transfer', 'withdraw'] as const) {
      notifier.notify(event(action));
    }
    await flush();

    expect(getSettings).toHaveBeenCalledOnce();
    expect(playBuy).not.toHaveBeenCalled();
  });

  it('isolates settings and audio failures behind a bounded callback', async () => {
    const onFailure = vi.fn();
    const settingsFailure = createLiveBuyNotifier({
      preferences: { getSettings: async () => { throw new Error('secret settings failure'); } },
      audio: { playBuy: vi.fn() },
      onFailure,
    });
    const audioFailure = createLiveBuyNotifier({
      preferences: { getSettings: async () => ({
        ...DEFAULT_SETTINGS,
        notifications: { ...DEFAULT_SETTINGS.notifications, soundEnabled: true },
      }) },
      audio: { playBuy: async () => { throw new Error('secret audio failure'); } },
      onFailure,
    });

    expect(() => settingsFailure.notify(event('buy'))).not.toThrow();
    expect(() => audioFailure.notify(event('buy'))).not.toThrow();
    await flush();

    expect(onFailure).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledWith();
  });
});
