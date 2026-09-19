import { describe, expect, it } from 'vitest';

import type { TradeEventV1 } from '../../src/domain/activity';
import { canMarkEventRead } from '../../src/popup/source-read-eligibility';

const event = (sources: TradeEventV1['sources'], source: TradeEventV1['source'] = 'fomo'): TradeEventV1 => ({
  schemaVersion: 1,
  id: 'event-1',
  source,
  ...(sources === undefined ? {} : { sources }),
  traderId: 'trader-1',
  traderHandle: 'trader',
  chain: 'solana',
  tokenAddress: 'Token111111111111111111111111111111111111111',
  tokenSymbol: 'TOKEN',
  action: 'buy',
  occurredAt: 1,
  receivedAt: 1,
});

describe('canMarkEventRead', () => {
  it('allows a Pump-only event without a live Fomo connection', () => {
    expect(canMarkEventRead(event(['pump'], 'pump'), 'pump', {
      ownsRead: true,
      fomoLive: false,
      pumpLive: true,
    })).toBe(true);
  });

  it('keeps a Fomo-only event read-only while Fomo is offline', () => {
    expect(canMarkEventRead(event(undefined), 'all', {
      ownsRead: true,
      fomoLive: false,
      pumpLive: true,
    })).toBe(false);
  });

  it('uses only the selected source projection for a merged event', () => {
    const merged = event(['fomo', 'pump']);
    const health = { ownsRead: true, fomoLive: false, pumpLive: true };

    expect(canMarkEventRead(merged, 'all', health)).toBe(true);
    expect(canMarkEventRead(merged, 'pump', health)).toBe(true);
    expect(canMarkEventRead(merged, 'fomo', health)).toBe(false);
  });

  it('never bypasses the active window read owner', () => {
    expect(canMarkEventRead(event(['pump'], 'pump'), 'pump', {
      ownsRead: false,
      fomoLive: true,
      pumpLive: true,
    })).toBe(false);
  });
});
