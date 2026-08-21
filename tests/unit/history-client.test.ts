import { readFileSync } from 'node:fs';

import { describe, expect, it, vi } from 'vitest';

import {
  FomoHistoryClient,
  normalizeHistoryPage,
  unavailableHistoryClient,
  type HistoryClient,
  type HistoryFetchResult,
} from '../../src/fomo/history-client';
import { parseHistoryPage } from '../../src/fomo/history-contract';

const NOW = 1_800_000_000_000;
const FIXTURE_PATH = 'tests/fixtures/fomo-history-page.redacted.json';

const readFixture = (): unknown =>
  JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as unknown;

const fixturePage = () => {
  const page = parseHistoryPage(readFixture());

  if (page === undefined) {
    throw new Error('fixture must parse');
  }

  return page;
};

const makeResponse = (overrides: {
  status?: number;
  ok?: boolean;
  body?: unknown;
  jsonThrows?: boolean;
}): Response =>
  ({
    status: overrides.status ?? 200,
    ok: overrides.ok ?? (overrides.status === undefined ? true : overrides.status! >= 200 && overrides.status! < 300),
    json: async () => {
      if (overrides.jsonThrows) {
        throw new Error('invalid json');
      }
      return overrides.body;
    },
  }) as unknown as Response;

describe('FomoHistoryClient (disabled production implementation)', () => {
  it('returns unavailable without issuing a request (evidence gate)', async () => {
    const fetchImpl = vi.fn<typeof fetch>();

    const client = new FomoHistoryClient({ fetchImpl });

    const result = await client.fetchHistory({ limit: 50 });

    expect(result).toEqual({ ok: false, reason: 'unavailable' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns unavailable for every trigger shape', async () => {
    const client = new FomoHistoryClient({ fetchImpl: vi.fn<typeof fetch>() });

    expect(await client.fetchHistory({ limit: 1 })).toEqual({ ok: false, reason: 'unavailable' });
    expect(await client.fetchHistory({ limit: 200, cursor: 'c' })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });

  it('exposes an honest no-op client constant used by the production root', async () => {
    expect(await unavailableHistoryClient.fetchHistory({ limit: 50 })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });
});

describe('normalizeHistoryPage', () => {
  it('normalizes every fixture activity through the shared normalize path', async () => {
    const events = await normalizeHistoryPage(fixturePage(), NOW);

    expect(events).toHaveLength(4);

    const [first, second, third, fourth] = events;

    expect(first?.id).toBe('fomo:act-history-synthetic-0001');
    expect(first?.sourceEventId).toBe('act-history-synthetic-0001');
    expect(first?.sourceTradeId).toBe('trade-history-synthetic-0001');
    expect(first?.action).toBe('buy');
    expect(first?.traderId).toBe('user-history-synthetic-0001');
    expect(first?.traderHandle).toBe('history-synthetic-trader-01');
    expect(first?.traderName).toBe('History Synthetic Trader One');
    expect(first?.tokenSymbol).toBe('SPRK');
    expect(first?.tokenAddress).toBe('0xabcdef1234567890abcd');
    expect(first?.networkId).toBe(56);
    expect(first?.occurredAt).toBe(Date.parse('2026-08-20T07:55:30.000Z'));
    expect(first?.receivedAt).toBe(NOW);
    expect(first?.usdAmount).toBe(990.5);
    expect(first?.marketCap).toBe(4_100_000);
    expect(first?.price).toBe(0.41);
    // Every catalogued network ID is still provisional-unverified, so the
    // honest chain classification is 'unknown' (see src/fomo/network-map.ts).
    expect(first?.chain).toBe('unknown');

    expect(second?.action).toBe('sell');
    expect(second?.usdAmount).toBe(420);
    expect(third?.action).toBe('thesis');
    expect(third?.thesis).toBe('SYNTHETIC PLACEHOLDER OPINION TEXT FOR HISTORY FIXTURE.');
    expect(fourth?.action).toBe('transfer');
    expect(fourth?.networkId).toBe(101);
    expect(fourth?.tokenAddress).toBe('SoLpump9SynthToken2222222222222222222222222222');
  });

  it('throws on an invalid receivedAt', async () => {
    await expect(normalizeHistoryPage(fixturePage(), -1)).rejects.toThrow();
    await expect(normalizeHistoryPage(fixturePage(), 1.5)).rejects.toThrow();
  });
});

describe('mock history client returning fixture events', () => {
  it('serves normalized fixture events through the HistoryClient contract', async () => {
    const events = await normalizeHistoryPage(fixturePage(), NOW);

    // A stand-in for a future verified adapter: the mock returns the
    // normalized fixture page the way a real client would.
    const mockClient: HistoryClient = {
      async fetchHistory(): Promise<HistoryFetchResult> {
        return { ok: true, events, nextCursor: 'SYNTHETIC-CURSOR-PLACEHOLDER-0001' };
      },
    };

    const result = await mockClient.fetchHistory({ limit: 50 });

    if (!result.ok) {
      throw new Error('mock client must succeed');
    }

    expect(result.events).toHaveLength(4);
    expect(result.nextCursor).toBe('SYNTHETIC-CURSOR-PLACEHOLDER-0001');
    expect(result.events[0]).toMatchObject({
      id: 'fomo:act-history-synthetic-0001',
      action: 'buy',
      occurredAt: Date.parse('2026-08-20T07:55:30.000Z'),
    });
  });
});

describe('FomoHistoryClient (enabled path, mocked fetch)', () => {
  it('fetches with credentials include, parses, and normalizes a 200 response', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse({ body: readFixture() }));

    const client = new FomoHistoryClient({ fetchImpl, enabled: true, now: () => NOW });

    const result = await client.fetchHistory({ limit: 50 });

    expect(result).toEqual({
      ok: true,
      events: await normalizeHistoryPage(fixturePage(), NOW),
      nextCursor: 'SYNTHETIC-CURSOR-PLACEHOLDER-0001',
    });

    const [url, init] = fetchImpl.mock.calls[0] ?? [];

    expect(String(url)).toBe('https://prod-api.fomo.family/v2/activities/me?limit=50');
    expect(init).toMatchObject({ method: 'GET', credentials: 'include' });
  });

  it('omits the next cursor when the page is terminal', async () => {
    const fixture = readFixture() as { responseObject: { activities: unknown[]; nextCursor: string; hasMore: boolean } };
    const terminal = {
      responseObject: { ...fixture.responseObject, nextCursor: null, hasMore: true },
    };
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(makeResponse({ body: terminal }));

    const client = new FomoHistoryClient({ fetchImpl, enabled: true, now: () => NOW });

    const result = await client.fetchHistory({ limit: 50 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextCursor).toBeUndefined();
    }
  });

  it.each([401, 403])('maps status %s to auth (login required)', async (status) => {
    const client = new FomoHistoryClient({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(makeResponse({ status })),
      enabled: true,
    });

    expect(await client.fetchHistory({ limit: 50 })).toEqual({ ok: false, reason: 'auth' });
  });

  it.each([429, 500, 503, 404])('maps status %s to server', async (status) => {
    const client = new FomoHistoryClient({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(makeResponse({ status })),
      enabled: true,
    });

    expect(await client.fetchHistory({ limit: 50 })).toEqual({ ok: false, reason: 'server' });
  });

  it('maps a fetch rejection to network', async () => {
    const client = new FomoHistoryClient({
      fetchImpl: vi.fn<typeof fetch>().mockRejectedValue(new Error('offline')),
      enabled: true,
    });

    expect(await client.fetchHistory({ limit: 50 })).toEqual({ ok: false, reason: 'network' });
  });

  it('maps a non-JSON body to malformed', async () => {
    const client = new FomoHistoryClient({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(makeResponse({ jsonThrows: true })),
      enabled: true,
    });

    expect(await client.fetchHistory({ limit: 50 })).toEqual({ ok: false, reason: 'malformed' });
  });

  it('maps an envelope or activity failing the contract to malformed', async () => {
    for (const body of [
      { responseObject: {} },
      { responseObject: { activities: [{ type: 'swap_buy' }] } },
      'not json',
    ]) {
      const client = new FomoHistoryClient({
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(makeResponse({ body })),
        enabled: true,
      });

      expect(await client.fetchHistory({ limit: 50 })).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('maps an out-of-bounds limit to malformed before fetching', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new FomoHistoryClient({ fetchImpl, enabled: true });

    expect(await client.fetchHistory({ limit: 0 })).toEqual({ ok: false, reason: 'malformed' });
    expect(await client.fetchHistory({ limit: 201 })).toEqual({ ok: false, reason: 'malformed' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
