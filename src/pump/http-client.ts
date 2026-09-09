import {
  MAX_PUMP_CURSOR_LENGTH,
  PumpProtocolError,
  parsePumpTradePage,
  type PumpPageParseResult,
} from './raw-schema';

const PUMP_FOLLOWING_TRADES_ENDPOINT =
  'https://frontend-api-v3.pump.fun/following-positions/alerts';
const REQUEST_TIMEOUT_MS = 4_000;

export type PumpFetchFailure =
  | 'authentication'
  | 'rate-limit'
  | 'server'
  | 'network'
  | 'protocol';

export class PumpFetchError extends Error {
  constructor(
    readonly kind: PumpFetchFailure,
    readonly retryAfterMs?: number,
  ) {
    super(`Pump request failed: ${kind}`);
    this.name = 'PumpFetchError';
  }
}

export function buildPumpFollowingTradesUrl(cursor?: string): string {
  if (cursor !== undefined && (cursor.length === 0 || cursor.length > MAX_PUMP_CURSOR_LENGTH)) {
    throw new TypeError('cursor must be a bounded non-empty string');
  }

  const url = new URL(PUMP_FOLLOWING_TRADES_ENDPOINT);
  url.searchParams.set('pageSize', '20');
  url.searchParams.set('kinds', 'trade');
  url.searchParams.set('minTradeAmountUsd', '0');
  if (cursor !== undefined) url.searchParams.set('cursor', cursor);
  return url.href;
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1_000);
  }

  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export interface FetchPumpFollowingTradesOptions {
  fetchFn?: typeof fetch;
  cursor?: string;
  signal?: AbortSignal;
  now?: () => number;
}

export async function fetchPumpFollowingTrades(
  options: FetchPumpFollowingTradesOptions = {},
): Promise<PumpPageParseResult> {
  const fetchFn = options.fetchFn ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abortFromCaller = (): void => controller.abort();
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });

  try {
    let response: Response;
    try {
      response = await fetchFn(buildPumpFollowingTradesUrl(options.cursor), {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        signal: controller.signal,
      });
    } catch {
      throw new PumpFetchError('network');
    }

    if (response.status === 401 || response.status === 403) {
      throw new PumpFetchError('authentication');
    }
    if (response.status === 429) {
      throw new PumpFetchError(
        'rate-limit',
        parseRetryAfter(response.headers.get('Retry-After'), (options.now ?? Date.now)()),
      );
    }
    if (response.status >= 500 && response.status <= 599) {
      throw new PumpFetchError('server');
    }
    if (!response.ok) {
      throw new PumpFetchError('protocol');
    }

    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new PumpFetchError('network');
    }

    const responseBytes = new TextEncoder().encode(text).byteLength;
    let payload: unknown;
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      throw new PumpFetchError('protocol');
    }

    try {
      return parsePumpTradePage(payload, responseBytes, (options.now ?? Date.now)());
    } catch (error) {
      if (error instanceof PumpProtocolError) {
        throw new PumpFetchError('protocol');
      }
      throw error;
    }
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }
}
