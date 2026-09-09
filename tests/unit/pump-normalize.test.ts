import fixture from '../fixtures/pump/following-trades-page.json';
import { toTradeEvent } from '../../src/domain/event-validation';
import { normalizePumpTrade } from '../../src/pump/normalize';
import { parsePumpTradePage } from '../../src/pump/raw-schema';

const rawTrade = () => parsePumpTradePage(fixture).accepted[0]!;

describe('normalizePumpTrade', () => {
  it('normalizes the confirmed Pump trade fields into a storable event', () => {
    const event = normalizePumpTrade(rawTrade(), 1_789_000_000_000, 'live');

    expect(event).toEqual(expect.objectContaining({
      schemaVersion: 1,
      id: 'pump:1399811149:synthetic-transaction-1',
      source: 'pump',
      sources: ['pump'],
      sourceTradeId: 'synthetic-transaction-1',
      traderId: 'synthetic-user-1',
      traderHandle: 'synthetic_trader',
      traderName: 'Synthetic Trader',
      chain: 'solana',
      networkId: 1399811149,
      tokenAddress: 'SyntheticMint111111111111111111111111111111',
      tokenSymbol: 'SYN',
      action: 'buy',
      usdAmount: 25.5,
      marketCap: 250000,
      price: 0.02,
      delivery: 'live',
    }));
    expect(toTradeEvent(event)).toEqual(event);
  });

  it('maps sell and recovered classification without synthesizing market cap', () => {
    const raw = rawTrade();
    const event = normalizePumpTrade({
      ...raw,
      chainId: 999_999,
      marketCap: undefined,
      trade: { ...raw.trade, isBuy: false },
    }, 1_789_000_000_000, 'recovered');

    expect(event.action).toBe('sell');
    expect(event.chain).toBe('unknown');
    expect(event.marketCap).toBeUndefined();
    expect(event.delivery).toBe('recovered');
  });

  it.each([
    'http://example.invalid/image.png',
    'javascript:alert(1)',
    'not-a-url',
  ])('drops unsafe image URL %s', (image) => {
    const raw = rawTrade();
    const event = normalizePumpTrade({
      ...raw,
      coinImage: image,
      author: { ...raw.author, profileImage: image },
    }, 1_789_000_000_000, 'live');

    expect(event.traderAvatarUrl).toBeUndefined();
    expect(event.tokenImageUrl).toBeUndefined();
  });
});
