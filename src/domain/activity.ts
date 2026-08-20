export type ChainKey =
  | 'solana'
  | 'ethereum'
  | 'bsc'
  | 'base'
  | 'monad'
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
