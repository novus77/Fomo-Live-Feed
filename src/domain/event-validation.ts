import type { MetricSnapshotV1, TradeEventV1 } from './activity';

/**
 * Shared runtime validation for TradeEventV1 rows (BLOCKING 3).
 *
 * Spec sections 3 and 8 require every payload to cross a runtime schema
 * validator before it reaches storage or the UI. This module is that
 * validator for the CANONICAL event shape. The Side Panel client in
 * src/popup/popup-io.ts re-validates every events.query row returned by
 *   the worker, dropping malformed rows (DB corruption or a future schema
 *   v2) instead of letting one bad row crash the whole popup.
 *
 * toTradeEvent rebuilds a TradeEventV1 that contains ONLY known fields and
 * returns null for anything malformed - hostile extra fields never survive.
 * A future schema version must bump TradeEventV1 and this validator together.
 */

export const EVENT_CHAIN_KEYS = [
  'bsc',
  'solana',
  'robinhood',
  'base',
  'ethereum',
  'x-layer',
  'unknown',
] as const;

export const EVENT_ACTIONS = [
  'buy',
  'sell',
  'withdraw',
  'transfer',
  'thesis',
] as const;

export const SNAPSHOT_SOURCES = [
  'fomo-profile',
  'fomo-leaderboard',
  'unknown',
] as const;

const isChainKey = (value: unknown): value is TradeEventV1['chain'] =>
  typeof value === 'string' && (EVENT_CHAIN_KEYS as readonly string[]).includes(value);

const isAction = (value: unknown): value is TradeEventV1['action'] =>
  typeof value === 'string' && (EVENT_ACTIONS as readonly string[]).includes(value);

const isSnapshotSource = (value: unknown): value is MetricSnapshotV1['source'] =>
  typeof value === 'string' && (SNAPSHOT_SOURCES as readonly string[]).includes(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isFiniteTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** Keeps only known metric fields; hostile extra fields never survive. */
export function sanitizeMetricSnapshot(
  value: unknown,
): MetricSnapshotV1 | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const fetchedAt = raw.fetchedAt;
  const source = raw.source;

  if (!isFiniteTimestamp(fetchedAt) || !isSnapshotSource(source)) {
    return undefined;
  }

  const pnl7d = raw.pnl7d;
  const winRate7d = raw.winRate7d;
  const followers = raw.followers;
  const tradeCount = raw.tradeCount;
  const averageHoldSeconds = raw.averageHoldSeconds;

  return {
    fetchedAt,
    source,
    ...(isFiniteNumber(pnl7d) ? { pnl7d } : {}),
    ...(isFiniteNumber(winRate7d) ? { winRate7d } : {}),
    ...(isFiniteNumber(followers) ? { followers } : {}),
    ...(isFiniteNumber(tradeCount) ? { tradeCount } : {}),
    ...(isFiniteNumber(averageHoldSeconds) ? { averageHoldSeconds } : {}),
  };
}

/**
 * Runtime-validates an unknown row and rebuilds a TradeEventV1 that contains
 * ONLY known fields. Anything malformed returns null and is silently dropped
 * by the caller - never rendered, never stored.
 */
export function toTradeEvent(payload: unknown): TradeEventV1 | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }

  const raw = payload as Record<string, unknown>;

  if (raw.schemaVersion !== 1 || raw.source !== 'fomo') {
    return null;
  }

  const id = raw.id;
  const traderId = raw.traderId;
  const traderHandle = raw.traderHandle;
  const chain = raw.chain;
  const tokenAddress = raw.tokenAddress;
  const tokenSymbol = raw.tokenSymbol;
  const action = raw.action;
  const occurredAt = raw.occurredAt;
  const receivedAt = raw.receivedAt;

  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof traderId !== 'string' ||
    traderId.length === 0 ||
    typeof traderHandle !== 'string' ||
    traderHandle.length === 0 ||
    !isChainKey(chain) ||
    typeof tokenAddress !== 'string' ||
    tokenAddress.length === 0 ||
    typeof tokenSymbol !== 'string' ||
    tokenSymbol.trim().length === 0 ||
    !isAction(action) ||
    !isFiniteTimestamp(occurredAt) ||
    !isFiniteTimestamp(receivedAt)
  ) {
    return null;
  }

  const sourceEventId = raw.sourceEventId;
  const sourceTradeId = raw.sourceTradeId;
  const traderName = raw.traderName;
  const traderAvatarUrl = raw.traderAvatarUrl;
  const networkId = raw.networkId;
  const tokenImageUrl = raw.tokenImageUrl;
  const usdAmount = raw.usdAmount;
  const marketCap = raw.marketCap;
  const price = raw.price;
  const thesis = raw.thesis;
  const readAt = raw.readAt;
  const metricSnapshot = sanitizeMetricSnapshot(raw.metricSnapshot);

  return {
    schemaVersion: 1,
    id,
    source: 'fomo',
    ...(typeof sourceEventId === 'string' ? { sourceEventId } : {}),
    ...(typeof sourceTradeId === 'string' ? { sourceTradeId } : {}),
    traderId,
    traderHandle,
    ...(typeof traderName === 'string' ? { traderName } : {}),
    ...(typeof traderAvatarUrl === 'string' ? { traderAvatarUrl } : {}),
    chain,
    ...(isFiniteTimestamp(networkId) ? { networkId } : {}),
    tokenAddress,
    tokenSymbol: tokenSymbol.trim(),
    ...(typeof tokenImageUrl === 'string' ? { tokenImageUrl } : {}),
    action,
    ...(isFiniteNumber(usdAmount) ? { usdAmount } : {}),
    ...(isFiniteNumber(marketCap) ? { marketCap } : {}),
    ...(isFiniteNumber(price) ? { price } : {}),
    ...(typeof thesis === 'string' ? { thesis } : {}),
    occurredAt,
    receivedAt,
    ...(isFiniteTimestamp(readAt) ? { readAt } : {}),
    ...(metricSnapshot !== undefined ? { metricSnapshot } : {}),
  };
}
