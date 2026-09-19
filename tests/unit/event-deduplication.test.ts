import type { TradeEventV1 } from '../../src/domain/activity';
import {
  isCrossSourceDuplicate,
  mergeEventSources,
} from '../../src/domain/event-deduplication';

const event = (overrides: Partial<TradeEventV1> = {}): TradeEventV1 => ({
  schemaVersion: 1,
  id: 'fomo:event',
  source: 'fomo',
  sources: ['fomo'],
  traderId: 'fomo-user',
  traderHandle: 'Trader_One',
  chain: 'solana',
  tokenAddress: 'So11111111111111111111111111111111111111112',
  tokenSymbol: 'SOL',
  action: 'buy',
  usdAmount: 25.5,
  marketCap: 100,
  occurredAt: 10_000,
  receivedAt: 10_100,
  ...overrides,
});

describe('cross-source event deduplication', () => {
  it('does not merge equal raw transaction identifiers across platforms', () => {
    const fomo = event({ sourceTradeId: 'same-transaction' });
    const pump = event({ id: 'pump:event', source: 'pump', sources: ['pump'], sourceTradeId: 'same-transaction' });
    expect(isCrossSourceDuplicate(fomo, pump)).toBe(false);
  });

  it('does not infer identity from a conservative-looking fingerprint', () => {
    const pump = event({
      id: 'pump:event',
      source: 'pump',
      sources: ['pump'],
      traderId: 'pump-user',
      traderHandle: '@trader_one',
      occurredAt: 11_999,
    });
    expect(isCrossSourceDuplicate(event(), pump)).toBe(false);
    expect(isCrossSourceDuplicate(event(), { ...pump, usdAmount: 25.51 })).toBe(false);
    expect(isCrossSourceDuplicate(event(), { ...pump, occurredAt: 12_001 })).toBe(false);
    expect(isCrossSourceDuplicate(event(), { ...pump, traderHandle: 'trader-two' })).toBe(false);
  });

  it('matches the same source and network trade captured through socket and DOM channels', () => {
    const socket = event({
      id: 'fomo:activity-id',
      sourceEventId: 'activity-id',
      sourceTradeId: 'trade-id',
    });
    const dom = event({
      id: 'fomo:dom-id',
      sourceEventId: 'dom-id',
      sourceTradeId: 'trade-id',
      traderId: 'Trader One',
      occurredAt: 70_000,
      marketCap: 101,
    });

    expect(isCrossSourceDuplicate(socket, dom)).toBe(true);
  });

  it('does not fuzzy-match separate trades from the same source', () => {
    const first = event();
    const second = event({
      id: 'fomo:another-event',
      occurredAt: 11_000,
    });

    expect(isCrossSourceDuplicate(first, second)).toBe(false);
  });

  it('does not merge provenance across sources without an explicit identity bridge', () => {
    const existing = event({ marketCap: 100 });
    const incoming = event({
      id: 'pump:event',
      source: 'pump',
      sources: ['pump'],
      marketCap: 200,
      tokenImageUrl: 'https://example.invalid/token.png',
    });
    expect(mergeEventSources(existing, incoming)).toBeUndefined();
  });
});
