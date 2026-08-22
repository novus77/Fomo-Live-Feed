/**
 * Canonical chain key (Task 3 six-chain catalog, spec section 8.1).
 *
 * The six product chains plus the `unknown` sentinel. Every numeric Fomo
 * network ID is still PROVISIONAL-UNVERIFIED (docs/evidence/fomo-network-
 * catalog.md), so normalization currently classifies every catalogued ID as
 * `unknown`; these keys describe what a verified capture WOULD resolve to.
 * Legacy values (e.g. `monad`) are deliberately NOT part of the union: stored
 * rows carrying them fail runtime validation (src/domain/event-validation.ts)
 * and are never rendered.
 */
export type ChainKey =
  | 'bsc'
  | 'solana'
  | 'robinhood'
  | 'base'
  | 'ethereum'
  | 'x-layer'
  | 'unknown';

export type ActivityAction =
  | 'buy'
  | 'sell'
  | 'withdraw'
  | 'transfer'
  | 'thesis';

export interface MetricSnapshotV1 {
  fetchedAt: number;
  source: 'fomo-profile' | 'fomo-leaderboard' | 'unknown';
  pnl7d?: number;
  winRate7d?: number;
  followers?: number;
  tradeCount?: number;
  averageHoldSeconds?: number;
}

export interface TradeEventV1 {
  schemaVersion: 1;
  id: string;
  source: 'fomo';
  sourceEventId?: string;
  sourceTradeId?: string;
  traderId: string;
  traderHandle: string;
  traderName?: string;
  traderAvatarUrl?: string;
  chain: ChainKey;
  networkId?: number;
  tokenAddress: string;
  tokenSymbol: string;
  tokenImageUrl?: string;
  action: ActivityAction;
  usdAmount?: number;
  marketCap?: number;
  price?: number;
  thesis?: string;
  occurredAt: number;
  receivedAt: number;
  readAt?: number;
  metricSnapshot?: MetricSnapshotV1;
}
