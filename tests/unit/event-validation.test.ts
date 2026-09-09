import { toTradeEvent } from '../../src/domain/event-validation';

const persistedDomEvent = {
  schemaVersion: 1,
  id: 'fomo:dom-57ba6aec',
  source: 'fomo',
  sourceEventId: 'dom-57ba6aec',
  traderId: 'ether_monk 盈利 +$62,028.29 1分钟 BLUE 持仓中 市值 $240M 以来',
  traderHandle: 'ether_monk 盈利 +$62,028.29 1分钟 BLUE 持仓中 市值 $240M 以来',
  traderName: 'ether_monk 盈利 +$62,028.29 1分钟 BLUE 持仓中 市值 $240M 以来',
  chain: 'base',
  networkId: 8453,
  tokenAddress: '0xb20000000000000000000000cfbdf64a8706a94a01',
  tokenSymbol: '以来',
  action: 'buy',
  occurredAt: 1_800_000,
  receivedAt: 1_800_000,
} as const;

describe('toTradeEvent Fomo DOM fallback validation', () => {
  it('drops a previously persisted activity assembled from a position summary', () => {
    expect(toTradeEvent(persistedDomEvent)).toBeNull();
  });

  it('keeps a coherent DOM fallback activity', () => {
    expect(toTradeEvent({
      ...persistedDomEvent,
      id: 'fomo:dom-valid',
      sourceEventId: 'dom-valid',
      traderId: 'frankdegods',
      traderHandle: 'frankdegods',
      traderName: 'frankdegods',
      tokenSymbol: 'BUDDY',
      action: 'thesis',
      thesis: '1 Trade 4 Ever Set',
    })).not.toBeNull();
  });
});
