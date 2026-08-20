import { z } from 'zod';

import type { ChainKey } from './activity';

export type MetricKey =
  | 'pnl7d'
  | 'winRate7d'
  | 'followers'
  | 'tradeCount'
  | 'averageHoldSeconds';

export interface LocalSettingsV1 {
  schemaVersion: 1;
  notifications: {
    enabled: boolean;
    maxVisibleToasts: 3;
    durationMs: number;
    soundEnabled: boolean;
  };
  metrics: {
    primary?: MetricKey;
    secondary?: MetricKey;
  };
  filters: {
    mutedChains: ChainKey[];
    minimumUsdAmount?: number;
  };
}

const CHAIN_KEYS = [
  'solana',
  'ethereum',
  'bsc',
  'base',
  'monad',
  'unknown',
] as const satisfies readonly ChainKey[];

export const chainKeySchema = z.enum(CHAIN_KEYS);

export const metricKeySchema = z.enum([
  'pnl7d',
  'winRate7d',
  'followers',
  'tradeCount',
  'averageHoldSeconds',
]);

export const localSettingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    notifications: z.object({
      enabled: z.boolean(),
      maxVisibleToasts: z.literal(3),
      durationMs: z.number().finite().nonnegative(),
      soundEnabled: z.boolean(),
    }),
    metrics: z.object({
      primary: metricKeySchema.optional(),
      secondary: metricKeySchema.optional(),
    }),
    filters: z.object({
      mutedChains: z.array(chainKeySchema),
      minimumUsdAmount: z.number().finite().nonnegative().optional(),
    }),
  })
  .passthrough();

export const DEFAULT_SETTINGS: LocalSettingsV1 = {
  schemaVersion: 1,
  notifications: {
    enabled: true,
    maxVisibleToasts: 3,
    durationMs: 8000,
    soundEnabled: false,
  },
  metrics: {
    primary: 'pnl7d',
    secondary: 'winRate7d',
  },
  filters: {
    mutedChains: [],
  },
};

export interface LocalSettingsUpdate {
  notifications?: Partial<LocalSettingsV1['notifications']>;
  metrics?: Partial<LocalSettingsV1['metrics']>;
  filters?: Partial<LocalSettingsV1['filters']>;
}
