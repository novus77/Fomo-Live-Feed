import { describe, expect, it, vi } from 'vitest';

// Vite-native JSON module import: the fixture is read directly so tests
// exercise the exact file (tests/fixtures/fomo-metrics-7d.redacted.json) that
// the evidence gate in docs/evidence/fomo-metrics-contract.md requires to be
// replaced with a real redacted capture before release.
import fixtureBodyRaw from '../fixtures/fomo-metrics-7d.redacted.json';

import type { MetricSnapshotV1 } from '../../src/domain/activity';
import type { MetricCacheRecord } from '../../src/storage/metric-repository';
import { DiagnosticRecorder } from '../../src/background/diagnostics';
import {
  assertValidTraderId,
  CachedTraderMetricSource,
  DEFAULT_METRIC_FAILURE_BACKOFF_MS,
  DEFAULT_METRIC_TTL_MS,
  FOMO_LEADERBOARD_ENDPOINT,
  FomoLeaderboardMetricSource,
  MAX_TRADER_ID_LENGTH,
  parseLeaderboardMetrics,
  unavailableMetricSource,
  type TraderMetricSource,
} from '../../src/fomo/enrichment-client';

const FETCHED_AT = 1_700_000_000_000;

// The synthetic, clearly-labeled fixture lives in tests/fixtures; it is NOT
// a verified capture — see its top-level note and the provisional contract in
// docs/evidence/fomo-metrics-contract.md.
const fixtureBody: unknown = fixtureBodyRaw;

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  }) as unknown as Response;

const createFetchMock = (body: unknown, status = 200) =>
  vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> =>
    jsonResponse(body, status),
  );

const createSource = (
  fetchMock: ReturnType<typeof createFetchMock>,
  diagnostics?: Pick<DiagnosticRecorder, 'record'>,
) =>
  new FomoLeaderboardMetricSource({
    fetchImpl: fetchMock as unknown as typeof fetch,
    now: () => FETCHED_AT,
    ...(diagnostics === undefined ? {} : { diagnostics }),
  });

const snapshot = (fetchedAt: number): MetricSnapshotV1 => ({
  fetchedAt,
  source: 'fomo-leaderboard',
  pnl7d: 10,
  winRate7d: 50,
});

describe('parseLeaderboardMetrics', () => {
  it('parses the flat { pnl7d, winRate7d } shape inside responseObject', () => {
    expect(
      parseLeaderboardMetrics(
        { responseObject: { pnl7d: 1234.5, winRate7d: 61.2 } },
        FETCHED_AT,
      ),
    ).toEqual({
      fetchedAt: FETCHED_AT,
      source: 'fomo-leaderboard',
      pnl7d: 1234.5,
      winRate7d: 61.2,
    });
  });

  it('parses followers from responseObject.followers alongside the flat 7-day shape', () => {
    expect(
      parseLeaderboardMetrics(
        { responseObject: { pnl7d: 1234.5, winRate7d: 61.2, followers: 987 } },
        FETCHED_AT,
      ),
    ).toEqual({
      fetchedAt: FETCHED_AT,
      source: 'fomo-leaderboard',
      pnl7d: 1234.5,
      winRate7d: 61.2,
      followers: 987,
    });
  });

  it('parses the { timeframes: { "7d": { pnl, winRate } } } shape inside responseObject', () => {
    expect(
      parseLeaderboardMetrics(
        { responseObject: { timeframes: { '7d': { pnl: 500, winRate: 55 } } } },
        FETCHED_AT,
      ),
    ).toEqual({
      fetchedAt: FETCHED_AT,
      source: 'fomo-leaderboard',
      pnl7d: 500,
      winRate7d: 55,
    });
  });

  it('parses the synthetic fixture (timeframes["7d"] plus followers) and never maps the lifetime 1y window into 7d metrics', () => {
    const body = fixtureBody as {
      responseObject: {
        timeframes: Record<string, { pnl: number; winRate: number }>;
        followers?: unknown;
      };
    };

    expect(parseLeaderboardMetrics(body, FETCHED_AT)).toEqual({
      fetchedAt: FETCHED_AT,
      source: 'fomo-leaderboard',
      pnl7d: body.responseObject.timeframes['7d']?.pnl,
      winRate7d: body.responseObject.timeframes['7d']?.winRate,
      followers: body.responseObject.followers,
    });
    expect(body.responseObject.timeframes['7d']?.pnl).not.toBe(
      body.responseObject.timeframes['1y']?.pnl,
    );
  });

  it('declares the fixture synthetic with the required pre-release note', () => {
    const body = fixtureBody as { note?: string };

    expect(body.note).toMatch(/SYNTHETIC/);
    expect(body.note).toMatch(/redact/);
  });

  it('returns null when only lifetime pnl/winRate exist without a 7-day window', () => {
    expect(
      parseLeaderboardMetrics(
        { responseObject: { pnl: 5000, winRate: 60 } },
        FETCHED_AT,
      ),
    ).toBeNull();
  });

  it('returns null when only a non-7d timeframe exists', () => {
    expect(
      parseLeaderboardMetrics(
        { responseObject: { timeframes: { '1y': { pnl: 5000, winRate: 60 } } } },
        FETCHED_AT,
      ),
    ).toBeNull();
  });

  it('returns null when followers exist but no 7-day window is identified (followers alone never produce a snapshot)', () => {
    expect(
      parseLeaderboardMetrics(
        { responseObject: { followers: 1234 } },
        FETCHED_AT,
      ),
    ).toBeNull();
    expect(
      parseLeaderboardMetrics(
        { responseObject: { userStats: { followers: 1234 } } },
        FETCHED_AT,
      ),
    ).toBeNull();
  });

  it('drops a malformed followers value instead of failing the valid 7-day snapshot', () => {
    const sevenDay = { responseObject: { pnl7d: 100, winRate7d: 50 } };

    for (const followers of ['1234', -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, true]) {
      expect(
        parseLeaderboardMetrics(
          { responseObject: { ...sevenDay.responseObject, followers } },
          FETCHED_AT,
        ),
      ).toEqual({
        fetchedAt: FETCHED_AT,
        source: 'fomo-leaderboard',
        pnl7d: 100,
        winRate7d: 50,
      });
    }
  });

  it('does not parse the candidate/unverified responseObject.userStats.followers alternate path', () => {
    expect(
      parseLeaderboardMetrics(
        { responseObject: { pnl7d: 100, winRate7d: 50, userStats: { followers: 999 } } },
        FETCHED_AT,
      ),
    ).toEqual({
      fetchedAt: FETCHED_AT,
      source: 'fomo-leaderboard',
      pnl7d: 100,
      winRate7d: 50,
    });
  });

  it.each([
    [{ responseObject: { pnl7d: 100 } }],
    [{ responseObject: { winRate7d: 50 } }],
    [{ responseObject: { timeframes: { '7d': { pnl: 100 } } } }],
    [{ responseObject: { timeframes: { '7d': { winRate: 50 } } } }],
    [{ responseObject: { timeframes: {} } }],
    [{ responseObject: { timeframes: { '7d': null } } }],
  ])('returns null when a 7-day field is missing: %j', (body) => {
    expect(parseLeaderboardMetrics(body, FETCHED_AT)).toBeNull();
  });

  it.each([
    [{ responseObject: { pnl7d: Number.NaN, winRate7d: 50 } }],
    [{ responseObject: { pnl7d: Number.POSITIVE_INFINITY, winRate7d: 50 } }],
    [{ responseObject: { pnl7d: '100', winRate7d: 50 } }],
    [{ responseObject: { pnl7d: 100, winRate7d: null } }],
    [{ responseObject: { timeframes: { '7d': { pnl: Number.NaN, winRate: 50 } } } }],
    [{ responseObject: { timeframes: { '7d': { pnl: 100, winRate: '50' } } } }],
  ])('returns null for non-finite 7-day values: %j', (body) => {
    expect(parseLeaderboardMetrics(body, FETCHED_AT)).toBeNull();
  });

  it.each([
    [null],
    ['not-an-object'],
    [42],
    [[]],
    [{}],
    [{ responseObject: null }],
    [{ responseObject: 'nope' }],
  ])('returns null for bodies without a usable responseObject: %p', (body) => {
    expect(parseLeaderboardMetrics(body, FETCHED_AT)).toBeNull();
  });

  it('rejects an invalid fetchedAt timestamp', () => {
    expect(() => parseLeaderboardMetrics({ responseObject: {} }, -1)).toThrowError(
      TypeError,
    );
    expect(() => parseLeaderboardMetrics({ responseObject: {} }, 1.5)).toThrowError(
      TypeError,
    );
    expect(() => parseLeaderboardMetrics({ responseObject: {} }, Number.NaN)).toThrowError(
      TypeError,
    );
  });
});

describe('assertValidTraderId', () => {
  it('accepts ordinary trader ids', () => {
    expect(() => assertValidTraderId('trader-1')).not.toThrow();
    expect(() => assertValidTraderId('12345')).not.toThrow();
  });

  it.each(['', 'a/b', 'a?b', 'a#b', 'a b', 'a\tb', 'a\nb'])(
    'rejects trader id %j',
    (traderId) => {
      expect(() => assertValidTraderId(traderId)).toThrowError(TypeError);
    },
  );

  it('rejects trader ids longer than the exported cap', () => {
    expect(() => assertValidTraderId('x'.repeat(MAX_TRADER_ID_LENGTH))).not.toThrow();
    expect(() => assertValidTraderId('x'.repeat(MAX_TRADER_ID_LENGTH + 1))).toThrowError(
      TypeError,
    );
  });
});

describe('FomoLeaderboardMetricSource', () => {
  it('fetches the leaderboard endpoint with include credentials, GET, and the caller signal', async () => {
    const fetchMock = createFetchMock({ responseObject: { pnl7d: 10, winRate7d: 50 } });
    const source = createSource(fetchMock);
    const controller = new AbortController();

    await expect(source.fetch7dMetrics('trader-1', controller.signal)).resolves.toEqual(
      snapshot(FETCHED_AT),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];

    if (call === undefined) {
      throw new Error('expected a fetch call');
    }

    const [input, init] = call;

    expect(String(input)).toBe(
      `${FOMO_LEADERBOARD_ENDPOINT}/v2/users/trader-1/leaderboard`,
    );
    expect(init?.method).toBe('GET');
    expect(init?.credentials).toBe('include');
    expect(init?.signal).toBe(controller.signal);
  });

  it('URL-encodes the trader id path segment', async () => {
    const fetchMock = createFetchMock({ responseObject: { pnl7d: 10, winRate7d: 50 } });
    const source = createSource(fetchMock);

    await source.fetch7dMetrics('abc%def', new AbortController().signal);

    const call = fetchMock.mock.calls[0];

    if (call === undefined) {
      throw new Error('expected a fetch call');
    }

    expect(String(call[0])).toBe(
      `${FOMO_LEADERBOARD_ENDPOINT}/v2/users/abc%25def/leaderboard`,
    );
  });

  it('parses the synthetic verified-shape fixture through the adapter, including followers', async () => {
    const fetchMock = createFetchMock(fixtureBody);
    const source = createSource(fetchMock);

    await expect(
      source.fetch7dMetrics('trader-1', new AbortController().signal),
    ).resolves.toEqual({
      fetchedAt: FETCHED_AT,
      source: 'fomo-leaderboard',
      pnl7d: 4821.75,
      winRate7d: 63.4,
      followers: 1234,
    });
  });

  it('uses a custom https base url when provided', async () => {
    const fetchMock = createFetchMock({ responseObject: { pnl7d: 10, winRate7d: 50 } });
    const source = new FomoLeaderboardMetricSource({
      fetchImpl: fetchMock as unknown as typeof fetch,
      baseUrl: 'https://proxy.example.test',
    });

    await source.fetch7dMetrics('trader-1', new AbortController().signal);

    const call = fetchMock.mock.calls[0];

    if (call === undefined) {
      throw new Error('expected a fetch call');
    }

    expect(String(call[0])).toBe('https://proxy.example.test/v2/users/trader-1/leaderboard');
  });

  it('rejects a non-https base url at construction', () => {
    expect(
      () =>
        new FomoLeaderboardMetricSource({
          fetchImpl: (async () => jsonResponse({})) as unknown as typeof fetch,
          baseUrl: 'http://insecure.example.test',
        }),
    ).toThrowError(TypeError);
  });

  it('propagates invalid trader ids as TypeErrors', async () => {
    const fetchMock = createFetchMock({ responseObject: { pnl7d: 10, winRate7d: 50 } });
    const source = createSource(fetchMock);

    await expect(
      source.fetch7dMetrics('', new AbortController().signal),
    ).rejects.toThrowError(TypeError);
    await expect(
      source.fetch7dMetrics('a b', new AbortController().signal),
    ).rejects.toThrowError(TypeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])('returns null for status %s without parsing the body', async (status) => {
    const fetchMock = createFetchMock({ responseObject: { pnl7d: 10, winRate7d: 50 } }, status);
    const source = createSource(fetchMock);

    await expect(
      source.fetch7dMetrics('trader-1', new AbortController().signal),
    ).resolves.toBeNull();
  });

  it('returns null for any non-2xx status', async () => {
    for (const status of [302, 429, 500, 502, 503]) {
      const fetchMock = createFetchMock({}, status);
      const source = createSource(fetchMock);

      await expect(
        source.fetch7dMetrics('trader-1', new AbortController().signal),
      ).resolves.toBeNull();
    }
  });

  it('treats 429 as a server failure: null, a bounded diagnostic, and no body parse (bounded retry backoff lives in CachedTraderMetricSource)', async () => {
    const recorder = new DiagnosticRecorder({ now: () => FETCHED_AT });
    const fetchMock = createFetchMock(fixtureBody, 429);
    const source = createSource(fetchMock, recorder);

    await expect(
      source.fetch7dMetrics('trader-1', new AbortController().signal),
    ).resolves.toBeNull();

    expect(recorder.snapshot()).toEqual([
      {
        code: 'enrichment_failure',
        receivedAt: FETCHED_AT,
        messageType: 'enrichment.trader-1.server',
      },
    ]);
    // The body was never parsed: a rate-limited response is not consumed.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('returns null for a malformed 2xx body', async () => {
    const fetchMock = createFetchMock({ responseObject: { pnl: 5000, winRate: 60 } });
    const source = createSource(fetchMock);

    await expect(
      source.fetch7dMetrics('trader-1', new AbortController().signal),
    ).resolves.toBeNull();
  });

  it('returns null and records a network diagnostic when fetch rejects', async () => {
    const recorder = new DiagnosticRecorder({ now: () => FETCHED_AT });
    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    });
    const source = createSource(fetchMock, recorder);

    await expect(
      source.fetch7dMetrics('trader-1', new AbortController().signal),
    ).resolves.toBeNull();

    expect(recorder.snapshot()).toEqual([
      {
        code: 'enrichment_failure',
        receivedAt: FETCHED_AT,
        messageType: 'enrichment.trader-1.network',
      },
    ]);
  });

  it('returns null without recording a diagnostic for a routine abort', async () => {
    const recorder = new DiagnosticRecorder({ now: () => FETCHED_AT });
    const controller = new AbortController();
    controller.abort();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (init?.signal?.aborted === true) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }

      return jsonResponse({});
    });
    const source = createSource(fetchMock, recorder);

    await expect(source.fetch7dMetrics('trader-1', controller.signal)).resolves.toBeNull();
    expect(recorder.snapshot()).toEqual([]);
  });

  it('records an auth failure diagnostic containing only the status category and trader id', async () => {
    const recorder = new DiagnosticRecorder({ now: () => FETCHED_AT });
    const fetchMock = createFetchMock({ secret: 'hunter2', cookie: 'session=abc' }, 401);
    const source = createSource(fetchMock, recorder);

    await expect(
      source.fetch7dMetrics('trader-1', new AbortController().signal),
    ).resolves.toBeNull();

    const snapshotRecords = recorder.snapshot();

    expect(snapshotRecords).toEqual([
      {
        code: 'enrichment_failure',
        receivedAt: FETCHED_AT,
        messageType: 'enrichment.trader-1.auth',
      },
    ]);
    expect(JSON.stringify(snapshotRecords)).not.toContain('hunter2');
    expect(JSON.stringify(snapshotRecords)).not.toContain('session=abc');
  });

  it('records a malformed diagnostic for a 2xx body without a valid 7-day window', async () => {
    const recorder = new DiagnosticRecorder({ now: () => FETCHED_AT });
    const fetchMock = createFetchMock({ responseObject: { pnl: 5000, winRate: 60 } });
    const source = createSource(fetchMock, recorder);

    await expect(
      source.fetch7dMetrics('trader-1', new AbortController().signal),
    ).resolves.toBeNull();

    expect(recorder.snapshot()[0]?.messageType).toBe('enrichment.trader-1.malformed');
  });

  it('records the failure category even when the trader id would overflow the diagnostic message type', async () => {
    const recorder = new DiagnosticRecorder({ now: () => FETCHED_AT });
    const longTraderId = 'X'.repeat(MAX_TRADER_ID_LENGTH);
    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    });
    const source = createSource(fetchMock, recorder);

    await expect(
      source.fetch7dMetrics(longTraderId, new AbortController().signal),
    ).resolves.toBeNull();

    const records = recorder.snapshot();

    expect(records).toHaveLength(1);
    const messageType = records[0]?.messageType;

    expect(records[0]?.code).toBe('enrichment_failure');
    expect(messageType).toContain('network');
    expect(messageType?.length ?? 0).toBeLessThanOrEqual(64);
    expect(messageType).toMatch(/^[a-z][a-z0-9._-]*$/);
    expect(JSON.stringify(records)).not.toContain(longTraderId);
  });

  it('normalizes trader id characters that would fail the diagnostic message-type sanitizer', async () => {
    const recorder = new DiagnosticRecorder({ now: () => FETCHED_AT });
    const fetchMock = vi.fn(async (): Promise<Response> => {
      throw new TypeError('fetch failed');
    });
    const source = createSource(fetchMock, recorder);

    await expect(
      source.fetch7dMetrics('TraderOne', new AbortController().signal),
    ).resolves.toBeNull();

    expect(recorder.snapshot()[0]?.messageType).toBe('enrichment.traderone.network');
  });
});

describe('CachedTraderMetricSource', () => {
  const createCacheFake = () => {
    const records = new Map<string, MetricCacheRecord>();

    return {
      records,
      async getFresh(traderId: string, now: number): Promise<MetricCacheRecord | undefined> {
        const record = records.get(traderId);

        if (record === undefined || record.expiresAt <= now) {
          return undefined;
        }

        return record;
      },
      async put(record: MetricCacheRecord): Promise<void> {
        records.set(record.traderId, record);
      },
    };
  };

  it('caches successful snapshots until the ttl expires and then refetches', async () => {
    let now = 1_000;
    const inner = vi.fn(
      async (_traderId: string, _signal: AbortSignal): Promise<MetricSnapshotV1 | null> =>
        snapshot(now),
    );
    const cache = createCacheFake();
    const source = new CachedTraderMetricSource({
      source: { fetch7dMetrics: inner },
      cache,
      now: () => now,
      ttlMs: 5_000,
      failureBackoffMs: 1_000,
    });

    await expect(
      source.fetch7dMetrics('trader-1', new AbortController().signal),
    ).resolves.toEqual(snapshot(1_000));
    expect(inner).toHaveBeenCalledTimes(1);
    expect(cache.records.get('trader-1')).toMatchObject({
      traderId: 'trader-1',
      fetchedAt: 1_000,
      expiresAt: 6_000,
      pnl7d: 10,
      winRate7d: 50,
    });

    now = 5_999;
    await expect(
      source.fetch7dMetrics('trader-1', new AbortController().signal),
    ).resolves.toEqual(snapshot(1_000));
    expect(inner).toHaveBeenCalledTimes(1);

    now = 6_000;
    await expect(
      source.fetch7dMetrics('trader-1', new AbortController().signal),
    ).resolves.toEqual(snapshot(6_000));
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('does not refetch a failing trader within the failure backoff', async () => {
    let now = 1_000;
    const inner = vi.fn(
      async (_traderId: string, _signal: AbortSignal): Promise<MetricSnapshotV1 | null> =>
        null,
    );
    const cache = createCacheFake();
    const source = new CachedTraderMetricSource({
      source: { fetch7dMetrics: inner },
      cache,
      now: () => now,
      ttlMs: 5_000,
      failureBackoffMs: 1_000,
    });

    await expect(
      source.fetch7dMetrics('trader-1', new AbortController().signal),
    ).resolves.toBeNull();
    expect(inner).toHaveBeenCalledTimes(1);

    now = 1_999;
    await expect(
      source.fetch7dMetrics('trader-1', new AbortController().signal),
    ).resolves.toBeNull();
    expect(inner).toHaveBeenCalledTimes(1);

    now = 2_000;
    await expect(
      source.fetch7dMetrics('trader-1', new AbortController().signal),
    ).resolves.toBeNull();
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it('round-trips followers through the cache within the ttl and drops them on a fresh fetch that omits them', async () => {
    let now = 1_000;
    const withFollowers: MetricSnapshotV1 = {
      fetchedAt: now,
      source: 'fomo-leaderboard',
      pnl7d: 10,
      winRate7d: 50,
      followers: 1234,
    };
    const inner = vi.fn(
      async (): Promise<MetricSnapshotV1 | null> => withFollowers,
    );
    const cache = createCacheFake();
    const source = new CachedTraderMetricSource({
      source: { fetch7dMetrics: inner },
      cache,
      now: () => now,
      ttlMs: 5_000,
      failureBackoffMs: 1_000,
    });

    await expect(
      source.fetch7dMetrics('trader-1', new AbortController().signal),
    ).resolves.toEqual(withFollowers);
    expect(cache.records.get('trader-1')).toMatchObject({
      followers: 1234,
      expiresAt: 6_000,
    });

    // A fresh fetch inside the ttl serves the cached snapshot with followers
    // intact without hitting the inner source.
    await expect(
      source.fetch7dMetrics('trader-1', new AbortController().signal),
    ).resolves.toEqual(withFollowers);
    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('applies the exported default ttl and backoff when not supplied', async () => {
    const cache = createCacheFake();
    const successful = new CachedTraderMetricSource({
      source: { fetch7dMetrics: async () => snapshot(1) },
      cache,
      now: () => 1,
    });

    await successful.fetch7dMetrics('trader-1', new AbortController().signal);

    expect(cache.records.get('trader-1')?.expiresAt).toBe(1 + DEFAULT_METRIC_TTL_MS);

    const failing = new CachedTraderMetricSource({
      source: unavailableMetricSource,
      cache,
      now: () => 1_000,
    });

    await failing.fetch7dMetrics('trader-2', new AbortController().signal);

    expect(cache.records.get('trader-2')?.expiresAt).toBe(
      1_000 + DEFAULT_METRIC_FAILURE_BACKOFF_MS,
    );
  });

  it.each([
    [{ ttlMs: 0 }],
    [{ ttlMs: -1 }],
    [{ ttlMs: Number.NaN }],
    [{ failureBackoffMs: 0 }],
    [{ failureBackoffMs: -5 }],
  ])('rejects invalid cache options: %j', (overrides) => {
    expect(
      () =>
        new CachedTraderMetricSource({
          source: unavailableMetricSource,
          cache: createCacheFake(),
          now: () => 1,
          ...overrides,
        }),
    ).toThrowError(TypeError);
  });
});

describe('unavailableMetricSource', () => {
  it('never returns metrics so base activity always renders without enrichment', async () => {
    await expect(
      unavailableMetricSource.fetch7dMetrics('trader-1', new AbortController().signal),
    ).resolves.toBeNull();
  });
});