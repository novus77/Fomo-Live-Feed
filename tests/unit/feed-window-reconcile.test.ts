import { describe, expect, it } from 'vitest';

import type { TradeEventV1 } from '../../src/domain/activity';
import { reconcileLiveFeedWindow } from '../../src/popup/feed-window-reconcile';

const event = (id: string, occurredAt: number, readAt?: number): TradeEventV1 => ({
  schemaVersion: 1,
  id,
  source: 'fomo',
  traderId: id,
  traderHandle: id,
  chain: 'bsc',
  tokenAddress: `0x${id.padStart(40, '0')}`,
  tokenSymbol: id,
  action: 'buy',
  occurredAt,
  receivedAt: occurredAt + 1,
  ...(readAt === undefined ? {} : { readAt }),
});

describe('reconcileLiveFeedWindow', () => {
  it('keeps loaded history while adding a fresh head and updating known rows', () => {
    const result = reconcileLiveFeedWindow(
      [event('oldest', 10), event('known', 20, 99)],
      [event('fresh', 30), event('known', 20)],
    );

    expect(result.map((item) => item.id)).toEqual(['fresh', 'known', 'oldest']);
    expect(result.find((item) => item.id === 'known')?.readAt).toBe(99);
  });
});
