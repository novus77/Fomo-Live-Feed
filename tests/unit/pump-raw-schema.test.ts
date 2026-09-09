import fixture from '../fixtures/pump/following-trades-page.json';
import {
  MAX_PUMP_PAGE_ITEMS,
  MAX_PUMP_RESPONSE_BYTES,
  PumpProtocolError,
  parsePumpTradePage,
} from '../../src/pump/raw-schema';

const validItem = fixture.items[0]!;

describe('parsePumpTradePage', () => {
  it('rejects trade timestamps materially in the future', () => {
    const future = '2026-09-09T02:10:01.000Z';
    const payload = {
      ...fixture,
      items: [{
        ...fixture.items[0],
        createdAt: future,
        trade: { ...fixture.items[0]!.trade, timestamp: future },
      }],
    };

    expect(parsePumpTradePage(payload, undefined, Date.parse('2026-09-09T02:00:00.000Z')))
      .toMatchObject({ accepted: [], rejectedCount: 1 });
  });
  it('accepts the confirmed trade page and strips unrelated fields', () => {
    const result = parsePumpTradePage({
      ...fixture,
      ignoredEnvelopeField: 'not forwarded',
      items: [{ ...validItem, ignoredItemField: 'not forwarded' }],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]).not.toHaveProperty('ignoredItemField');
    expect(result.accepted[0]!.trade.tx).toBe('synthetic-transaction-1');
    expect(result.rejectedCount).toBe(0);
    expect(result.nextCursor).toBe('synthetic-cursor-1');
  });

  it('omits oversized optional image fields without rejecting the trade', () => {
    const result = parsePumpTradePage({
      items: [{
        ...validItem,
        coinImage: 'x'.repeat(2_049),
        author: { ...validItem.author, profileImage: 'x'.repeat(2_049) },
      }],
      nextCursor: null,
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.coinImage).toBeUndefined();
    expect(result.accepted[0]!.author.profileImage).toBeUndefined();
    expect(result.nextCursor).toBeUndefined();
  });

  it('accepts a null optional X username from Pump', () => {
    const result = parsePumpTradePage({
      items: [{
        ...validItem,
        author: { ...validItem.author, xUsername: null },
      }],
      nextCursor: null,
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]!.author.xUsername).toBeUndefined();
    expect(result.rejectedCount).toBe(0);
  });

  it.each([
    null,
    [],
    {},
    { items: 'invalid' },
    { items: [], nextCursor: 123 },
  ])('rejects an invalid top-level envelope: %j', (payload) => {
    expect(() => parsePumpTradePage(payload)).toThrow(PumpProtocolError);
  });

  it('rejects an oversized response before inspecting its contents', () => {
    expect(() => parsePumpTradePage(fixture, MAX_PUMP_RESPONSE_BYTES + 1)).toThrow(
      PumpProtocolError,
    );
  });

  it('rejects pages above the item and cursor bounds', () => {
    expect(() => parsePumpTradePage({
      items: Array.from({ length: MAX_PUMP_PAGE_ITEMS + 1 }, () => validItem),
      nextCursor: null,
    })).toThrow(PumpProtocolError);

    expect(() => parsePumpTradePage({
      items: [],
      nextCursor: 'x'.repeat(4_097),
    })).toThrow(PumpProtocolError);
  });

  it('keeps valid peers when item failures stay below the critical threshold', () => {
    const result = parsePumpTradePage({
      items: [validItem, { ...validItem, trade: { ...validItem.trade, tx: '' } }],
      nextCursor: null,
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejectedCount).toBe(1);
  });

  it('stops when at least three and at least twenty percent of items fail', () => {
    const invalid = { ...validItem, coinMint: '' };
    const items = [invalid, invalid, invalid, ...Array.from({ length: 7 }, () => validItem)];

    expect(() => parsePumpTradePage({ items, nextCursor: null })).toThrow(
      PumpProtocolError,
    );
  });

  it.each([
    { path: 'author.userId', change: { author: { ...validItem.author, userId: '' } } },
    { path: 'coinMint', change: { coinMint: 'x'.repeat(129) } },
    { path: 'symbol', change: { symbol: 'x'.repeat(65) } },
    { path: 'trade.tx', change: { trade: { ...validItem.trade, tx: 'x'.repeat(129) } } },
    { path: 'trade.timestamp', change: { trade: { ...validItem.trade, timestamp: 'not-a-date' } } },
    { path: 'trade.amountUsd', change: { trade: { ...validItem.trade, amountUsd: -1 } } },
    { path: 'marketCap', change: { marketCap: 1e15 + 1 } },
  ])('rejects an item with invalid $path', ({ change }) => {
    const result = parsePumpTradePage({
      items: [{ ...validItem, ...change }],
      nextCursor: null,
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejectedCount).toBe(1);
  });
});
