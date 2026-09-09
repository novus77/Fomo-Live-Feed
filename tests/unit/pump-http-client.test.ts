import fixture from '../fixtures/pump/following-trades-page.json';
import {
  PumpFetchError,
  buildPumpFollowingTradesUrl,
  fetchPumpFollowingTrades,
} from '../../src/pump/http-client';

describe('buildPumpFollowingTradesUrl', () => {
  it('builds only the fixed official endpoint and bounded cursor query', () => {
    expect(buildPumpFollowingTradesUrl()).toBe(
      'https://frontend-api-v3.pump.fun/following-positions/alerts?pageSize=20&kinds=trade&minTradeAmountUsd=0',
    );
    expect(buildPumpFollowingTradesUrl('cursor value')).toBe(
      'https://frontend-api-v3.pump.fun/following-positions/alerts?pageSize=20&kinds=trade&minTradeAmountUsd=0&cursor=cursor+value',
    );
    expect(() => buildPumpFollowingTradesUrl('x'.repeat(4_097))).toThrow(TypeError);
  });
});

describe('fetchPumpFollowingTrades', () => {
  it('uses an authenticated, uncached GET and returns a sanitized page', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));

    const page = await fetchPumpFollowingTrades({ fetchFn });

    expect(fetchFn).toHaveBeenCalledWith(
      buildPumpFollowingTradesUrl(),
      expect.objectContaining({
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
      }),
    );
    expect(page.accepted).toHaveLength(1);
    expect(page.accepted[0]!.trade.tx).toBe('synthetic-transaction-1');
  });

  it.each([
    [401, 'authentication'],
    [403, 'authentication'],
    [500, 'server'],
    [503, 'server'],
  ] as const)('maps HTTP %s to the closed %s failure', async (status, kind) => {
    const fetchFn = vi.fn(async () => new Response('', { status }));

    await expect(fetchPumpFollowingTrades({ fetchFn })).rejects.toMatchObject({
      name: 'PumpFetchError',
      kind,
    });
  });

  it('parses Retry-After without exposing the response body', async () => {
    const fetchFn = vi.fn(async () => new Response('private body', {
      status: 429,
      headers: { 'Retry-After': '5' },
    }));

    await expect(fetchPumpFollowingTrades({ fetchFn })).rejects.toEqual(
      expect.objectContaining({ kind: 'rate-limit', retryAfterMs: 5_000 }),
    );

    try {
      await fetchPumpFollowingTrades({ fetchFn });
    } catch (error) {
      expect(String(error)).not.toContain('private body');
    }
  });

  it('maps malformed 200 responses to protocol failure', async () => {
    const fetchFn = vi.fn(async () => new Response('{not json', { status: 200 }));

    await expect(fetchPumpFollowingTrades({ fetchFn })).rejects.toBeInstanceOf(PumpFetchError);
    await expect(fetchPumpFollowingTrades({ fetchFn })).rejects.toMatchObject({ kind: 'protocol' });
  });

  it('maps rejected fetches to network failure without echoing their message', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('secret-bearing network message');
    });

    try {
      await fetchPumpFollowingTrades({ fetchFn });
      throw new Error('expected failure');
    } catch (error) {
      expect(error).toEqual(expect.objectContaining({ kind: 'network' }));
      expect(String(error)).not.toContain('secret-bearing');
    }
  });
});
