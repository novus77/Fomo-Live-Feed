import type { TradeEventV1 } from '../domain/activity';
import {
  FOMO_HISTORY_BASE_URL,
  buildHistoryUrl,
  historyQuerySchema,
  parseHistoryPage,
  type RecoveredActivityPage,
} from './history-contract';
import { normalizeActivity } from './normalize';

/**
 * Authenticated history adapter (recovery plan Task 4).
 *
 * The adapter issues
 * `GET https://prod-api.fomo.family/v2/activities/me?cursor=&limit=`
 * with `credentials: 'include'` so the request rides the browser-managed Fomo
 * session; it never reads, stores, or logs session credentials, headers, or
 * tokens. Responses are parsed with src/fomo/history-contract.ts and every
 * activity is normalized through src/fomo/normalize.ts (the same path as live
 * WebSocket frames), producing canonical TradeEventV1 rows.
 *
 * EVIDENCE GATE: the production adapter is DELIBERATELY DISABLED until a real
 * authenticated request/response pair is captured, redacted, and the history
 * contract (docs/evidence/fomo-history-contract.md, status
 * PROVISIONAL-UNVERIFIED) is promoted to verified-from-capture. Until then
 * `new FomoHistoryClient()` returns `{ ok: false, reason: 'unavailable' }`
 * and never issues the request. The full fetch -> parse -> normalize path is
 * implemented and exercised by tests with a mocked fetch, so enabling the
 * adapter is a one-line flag swap once the evidence gate passes (see
 * entrypoints/background.ts for the production wiring comment).
 */

export interface HistoryClient {
  fetchHistory(options: {
    cursor?: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<HistoryFetchResult>;
}

export type HistoryFailureReason =
  | 'auth'
  | 'network'
  | 'server'
  | 'malformed'
  | 'unavailable';

export type HistoryFetchResult =
  | { ok: true; events: TradeEventV1[]; nextCursor?: string }
  | { ok: false; reason: HistoryFailureReason };

/**
 * Normalizes every raw activity in a parsed page through the shared
 * normalizeActivity path. Throws when `receivedAt` is invalid or when any
 * activity fails normalization (the page parser already validated the raw
 * shape, so a throw here signals a normalization-stage defect — callers map
 * it to 'malformed').
 */
export async function normalizeHistoryPage(
  page: RecoveredActivityPage,
  receivedAt: number,
): Promise<TradeEventV1[]> {
  if (!Number.isInteger(receivedAt) || receivedAt < 0) {
    throw new TypeError('receivedAt must be a finite non-negative integer');
  }

  const events: TradeEventV1[] = [];

  for (const activity of page.activities) {
    events.push(await normalizeActivity(activity, receivedAt));
  }

  return events;
}

export interface FomoHistoryClientOptions {
  /** Injected fetch so unit tests need no real network or Chrome. */
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  now?: () => number;
  /**
   * EVIDENCE GATE (docs/evidence/fomo-history-contract.md): must stay false
   * in production until a real authenticated capture is promoted to
   * verified-from-capture. Tests enable the full path with a mocked fetch.
   */
  enabled?: boolean;
}

/**
 * Production history adapter. Constructed with the default options it is the
 * DISABLED implementation required by the recovery plan: it returns
 * `{ ok: false, reason: 'unavailable' }` and never issues a request. With
 * `enabled: true` (tests only) it runs the production-ready fetch -> parse ->
 * normalize path.
 */
export class FomoHistoryClient implements HistoryClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly now: () => number;
  private readonly enabled: boolean;

  constructor(options: FomoHistoryClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.enabled = options.enabled ?? false;
    this.now = options.now ?? (() => Date.now());

    const baseUrl = new URL(options.baseUrl ?? FOMO_HISTORY_BASE_URL);

    if (baseUrl.protocol !== 'https:') {
      throw new TypeError('baseUrl must use the https: protocol');
    }

    this.baseUrl = baseUrl.origin;
  }

  async fetchHistory(options: {
    cursor?: string;
    limit: number;
    signal?: AbortSignal;
  }): Promise<HistoryFetchResult> {
    if (!this.enabled) {
      // EVIDENCE GATE: no real authenticated capture of
      // GET https://prod-api.fomo.family/v2/activities/me exists yet
      // (docs/evidence/fomo-history-contract.md is PROVISIONAL-UNVERIFIED),
      // so the production adapter is deliberately disabled and never issues
      // the request. Re-enable ONLY after a verified, redacted capture is
      // promoted and this comment's gate is lifted in entrypoints/background.ts.
      console.warn(
        '[fomo-history] recovery adapter disabled (evidence gate): returning unavailable without issuing a request',
      );
      return { ok: false, reason: 'unavailable' };
    }

    const query = historyQuerySchema.safeParse({
      cursor: options.cursor,
      limit: options.limit,
    });

    if (!query.success) {
      return { ok: false, reason: 'malformed' };
    }

    const url = buildHistoryUrl(query.data);

    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        credentials: 'include',
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        headers: { Accept: 'application/json' },
      });
    } catch {
      // Network failure or a routine abort of a bounded fetch timeout.
      return { ok: false, reason: 'network' };
    }

    // Contract status semantics: 401/403 mean the session is missing or
    // rejected (login required); every other non-2xx is a server failure.
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'auth' };
    }

    if (!response.ok) {
      return { ok: false, reason: 'server' };
    }

    let body: unknown;

    try {
      body = await response.json();
    } catch {
      return { ok: false, reason: 'malformed' };
    }

    const page = parseHistoryPage(body);

    if (page === undefined) {
      return { ok: false, reason: 'malformed' };
    }

    let events: TradeEventV1[];

    try {
      events = await normalizeHistoryPage(page, this.now());
    } catch {
      return { ok: false, reason: 'malformed' };
    }

    return {
      ok: true,
      events,
      ...(page.nextCursor !== undefined && !page.complete
        ? { nextCursor: page.nextCursor }
        : {}),
    };
  }
}

/**
 * Honest no-op client used until a REAL redacted production capture exists
 * (the evidence gate in docs/evidence/fomo-history-contract.md). Recovery
 * simply stays unavailable; the adapter, parser, and coordinator are
 * production-ready so this can be swapped for
 * `new FomoHistoryClient({ enabled: true, ... })` the moment a verified
 * capture is promoted — see entrypoints/background.ts for the wiring comment.
 */
export const unavailableHistoryClient: HistoryClient = {
  async fetchHistory(): Promise<HistoryFetchResult> {
    return { ok: false, reason: 'unavailable' };
  },
};
