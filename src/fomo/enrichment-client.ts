import type { MetricSnapshotV1 } from '../domain/activity';
import type { MetricCacheRecord } from '../storage/metric-repository';
import type { DiagnosticRecorder } from '../background/diagnostics';

/**
 * Authenticated trader-metric enrichment (design spec sections 3 and 5.2).
 *
 * The enrichment path NEVER blocks the base-event broadcast: ingest-activity
 * starts enrichment only after the broadcast completes, and every failure
 * here degrades to a null snapshot that the UI renders as "metrics
 * temporarily unavailable".
 *
 * WINDOW CORRECTNESS: a metric is parsed ONLY when the response explicitly
 * identifies the 7-day window ({ pnl7d, winRate7d } or a "7d" timeframe).
 * Lifetime PnL / win rate are never mapped into pnl7d / winRate7d (spec
 * section 5.2: "must not silently substitute lifetime metrics for 7-day
 * metrics").
 */

/** The contract the ingest use case depends on; swap the adapter for tests. */
export interface TraderMetricSource {
  fetch7dMetrics(traderId: string, signal: AbortSignal): Promise<MetricSnapshotV1 | null>;
}

/**
 * Closed set of failure categories used ONLY inside the redacted
 * enrichment-failure diagnostic's messageType. Nothing else about a failed
 * response (body, headers, cookies, URL query) is ever recorded.
 */
export type EnrichmentFailureCategory =
  | 'auth'
  | 'not-found'
  | 'server'
  | 'malformed'
  | 'network';

export const DEFAULT_METRIC_TTL_MS = 5 * 60 * 1_000;
export const DEFAULT_METRIC_FAILURE_BACKOFF_MS = 60 * 1_000;

/** Matches the transport-level cap in src/messaging/protocol.ts. */
export const MAX_TRADER_ID_LENGTH = 128;

/**
 * Longest trader-id prefix that fits inside the redacted diagnostic
 * messageType. The DiagnosticRecorder caps messageType at 64 characters and
 * requires the pattern /^[a-z][a-z0-9._-]*$/; 'enrichment.' (12) + this (40) +
 * '.' (1) + the longest category 'not-found' (9) = 62, always under the cap.
 */
export const MAX_DIAGNOSTIC_TRADER_ID_CHARS = 40;

const DIAGNOSTIC_TRADER_ID_PATTERN = /[^a-z0-9._-]/g;

/**
 * Makes a trader id safe to embed in the length-capped, pattern-restricted
 * diagnostic messageType (SHOULD-FIX 7): lowercased (assertValidTraderId
 * permits uppercase, which the sanitizer would otherwise reject), hostile
 * characters replaced, and truncated so an unbounded id can never overflow
 * the cap or be silently dropped.
 */
export function sanitizeDiagnosticTraderId(traderId: string): string {
  const normalized = traderId.toLowerCase().replace(DIAGNOSTIC_TRADER_ID_PATTERN, '-');

  return normalized.slice(0, MAX_DIAGNOSTIC_TRADER_ID_CHARS);
}

/** Fixed HTTPS origin for the leaderboard endpoint. */
export const FOMO_LEADERBOARD_ENDPOINT = 'https://prod-api.fomo.family';

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * Parses a leaderboard response body into a 7-day metric snapshot, or null
 * when the body does not explicitly identify a 7-day window. Accepts either
 * { responseObject: { pnl7d, winRate7d } } or
 * { responseObject: { timeframes: { "7d": { pnl, winRate } } } }. Both
 * metrics must be finite numbers; any other shape — including lifetime-only
 * payloads — returns null rather than guessing.
 */
export function parseLeaderboardMetrics(
  body: unknown,
  fetchedAt: number,
): MetricSnapshotV1 | null {
  if (!isFiniteNonNegativeInteger(fetchedAt)) {
    throw new TypeError('fetchedAt must be a finite non-negative integer');
  }

  if (!isPlainObject(body)) {
    return null;
  }

  const responseObject = body.responseObject;

  if (!isPlainObject(responseObject)) {
    return null;
  }

  if (isFiniteNumber(responseObject.pnl7d) && isFiniteNumber(responseObject.winRate7d)) {
    return {
      fetchedAt,
      source: 'fomo-leaderboard',
      pnl7d: responseObject.pnl7d,
      winRate7d: responseObject.winRate7d,
    };
  }

  const timeframes = responseObject.timeframes;

  if (isPlainObject(timeframes)) {
    const sevenDay = timeframes['7d'];

    if (
      isPlainObject(sevenDay) &&
      isFiniteNumber(sevenDay.pnl) &&
      isFiniteNumber(sevenDay.winRate)
    ) {
      return {
        fetchedAt,
        source: 'fomo-leaderboard',
        pnl7d: sevenDay.pnl,
        winRate7d: sevenDay.winRate,
      };
    }
  }

  return null;
}

/**
 * Rejects trader IDs that are empty, contain a path/query/fragment separator
 * or whitespace, or exceed the length cap. The adapter URL-encodes the path
 * segment anyway, but the validation keeps hostile input out of the URL
 * before encoding (a '/' would otherwise change the path shape).
 */
export function assertValidTraderId(traderId: string): void {
  if (typeof traderId !== 'string' || traderId.length === 0) {
    throw new TypeError('traderId must be a non-empty string');
  }

  if (traderId.length > MAX_TRADER_ID_LENGTH) {
    throw new TypeError(
      `traderId must be at most ${MAX_TRADER_ID_LENGTH} characters`,
    );
  }

  if (/[/?#\s]/.test(traderId)) {
    throw new TypeError('traderId must not contain / ? # or whitespace');
  }
}

export interface FomoLeaderboardMetricSourceOptions {
  /** Injected fetch so unit tests need no real network or Chrome. */
  fetchImpl: typeof fetch;
  now?: () => number;
  baseUrl?: string;
  /**
   * Optional redacted diagnostic sink (the real DiagnosticRecorder). Only the
   * status category and trader ID are recorded — never body, headers, or
   * cookies.
   */
  diagnostics?: Pick<DiagnosticRecorder, 'record'>;
}

/**
 * Authenticated adapter for GET
 * https://prod-api.fomo.family/v2/users/{traderId}/leaderboard.
 *
 * The request reuses the user's Fomo session via credentials: 'include'.
 * 401/403/404, any non-2xx, unparseable bodies, and bodies without an
 * explicit 7-day window all return null.
 */
export class FomoLeaderboardMetricSource implements TraderMetricSource {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly baseUrl: string;
  private readonly diagnostics: Pick<DiagnosticRecorder, 'record'> | undefined;

  constructor(options: FomoLeaderboardMetricSourceOptions) {
    this.fetchImpl = options.fetchImpl;
    this.now = options.now ?? (() => Date.now());
    this.diagnostics = options.diagnostics;

    const baseUrl = new URL(options.baseUrl ?? FOMO_LEADERBOARD_ENDPOINT);

    if (baseUrl.protocol !== 'https:') {
      throw new TypeError('baseUrl must use the https: protocol');
    }

    this.baseUrl = baseUrl.origin;
  }

  async fetch7dMetrics(
    traderId: string,
    signal: AbortSignal,
  ): Promise<MetricSnapshotV1 | null> {
    assertValidTraderId(traderId);

    const url = new URL(
      `/v2/users/${encodeURIComponent(traderId)}/leaderboard`,
      this.baseUrl,
    );

    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        credentials: 'include',
        signal,
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      // A routine abort is not an enrichment failure: report nothing.
      if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        return null;
      }

      this.recordFailure('network', traderId);
      return null;
    }

    if (response.status === 401 || response.status === 403) {
      this.recordFailure('auth', traderId);
      return null;
    }

    if (response.status === 404) {
      this.recordFailure('not-found', traderId);
      return null;
    }

    if (!response.ok) {
      this.recordFailure('server', traderId);
      return null;
    }

    let body: unknown;

    try {
      body = await response.json();
    } catch {
      this.recordFailure('malformed', traderId);
      return null;
    }

    const snapshot = parseLeaderboardMetrics(body, this.now());

    if (snapshot === null) {
      this.recordFailure('malformed', traderId);
    }

    return snapshot;
  }

  /**
   * Records ONLY the status category and a BOUNDED, sanitized trader ID
   * (both inside the redacted messageType code). The trader id is normalized
   * with sanitizeDiagnosticTraderId so an unbounded or uppercase id can never
   * overflow the DiagnosticRecorder's 64-char messageType cap (which would
   * silently DROP the whole failure record); the status category always
   * survives, which is the point of the record.
   */
  private recordFailure(category: EnrichmentFailureCategory, traderId: string): void {
    this.diagnostics?.record({
      code: 'enrichment_failure',
      messageType: `enrichment.${sanitizeDiagnosticTraderId(traderId)}.${category}`,
    });
  }
}

export interface MetricCacheLike {
  getFresh(traderId: string, now: number): Promise<MetricCacheRecord | undefined>;
  put(record: MetricCacheRecord): Promise<void>;
}

export interface CachedTraderMetricSourceOptions {
  source: TraderMetricSource;
  cache: MetricCacheLike;
  now: () => number;
  ttlMs?: number;
  failureBackoffMs?: number;
}

/**
 * Cache-and-backoff wrapper over any TraderMetricSource (spec section 8
 * "Metric failure"): successful snapshots are cached for ttlMs, and failures
 * are negative-cached for failureBackoffMs so a failing trader is not
 * refetched on every event. Negative records carry source 'unknown' and are
 * indistinguishable from "no metrics available right now".
 */
export class CachedTraderMetricSource implements TraderMetricSource {
  private readonly source: TraderMetricSource;
  private readonly cache: MetricCacheLike;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly failureBackoffMs: number;

  constructor(options: CachedTraderMetricSourceOptions) {
    const ttlMs = options.ttlMs ?? DEFAULT_METRIC_TTL_MS;
    const failureBackoffMs = options.failureBackoffMs ?? DEFAULT_METRIC_FAILURE_BACKOFF_MS;

    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new TypeError('ttlMs must be a positive finite number');
    }

    if (!Number.isFinite(failureBackoffMs) || failureBackoffMs <= 0) {
      throw new TypeError('failureBackoffMs must be a positive finite number');
    }

    this.source = options.source;
    this.cache = options.cache;
    this.now = options.now;
    this.ttlMs = ttlMs;
    this.failureBackoffMs = failureBackoffMs;
  }

  async fetch7dMetrics(
    traderId: string,
    signal: AbortSignal,
  ): Promise<MetricSnapshotV1 | null> {
    const now = this.now();
    const cached = await this.cache.getFresh(traderId, now);

    if (cached !== undefined) {
      return toSnapshot(cached);
    }

    const snapshot = await this.source.fetch7dMetrics(traderId, signal);

    if (snapshot !== null) {
      await this.cache.put({
        ...snapshot,
        traderId,
        fetchedAt: now,
        expiresAt: now + this.ttlMs,
      });
      return snapshot;
    }

    await this.cache.put({
      traderId,
      fetchedAt: now,
      expiresAt: now + this.failureBackoffMs,
      source: 'unknown',
    });
    return null;
  }
}

function toSnapshot(record: MetricCacheRecord): MetricSnapshotV1 | null {
  if (record.source === 'unknown') {
    return null;
  }

  return {
    fetchedAt: record.fetchedAt,
    source: record.source,
    ...(record.pnl7d !== undefined ? { pnl7d: record.pnl7d } : {}),
    ...(record.winRate7d !== undefined ? { winRate7d: record.winRate7d } : {}),
    ...(record.followers !== undefined ? { followers: record.followers } : {}),
    ...(record.tradeCount !== undefined ? { tradeCount: record.tradeCount } : {}),
    ...(record.averageHoldSeconds !== undefined
      ? { averageHoldSeconds: record.averageHoldSeconds }
      : {}),
  };
}

/**
 * Honest no-op source used until a real redacted production capture exists
 * (see tests/fixtures/fomo-leaderboard-7d.json). Base activity always renders;
 * metrics simply stay unavailable.
 */
export const unavailableMetricSource: TraderMetricSource = {
  async fetch7dMetrics(): Promise<MetricSnapshotV1 | null> {
    return null;
  },
};
