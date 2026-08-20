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

/**
 * Single source of truth for the ordered metric keys (SHOULD-FIX 9): the
 * SettingsPanel imports this instead of redeclaring its own catalog.
 */
export const METRIC_KEYS: readonly MetricKey[] = metricKeySchema.options;

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
  .passthrough()
  .superRefine((settings, ctx) => {
    // NIT: the duplicate primary/secondary rejection used to live ONLY in the
    // SettingsPanel UI; the storage schema now rejects it too, so a malformed
    // stored record (or a future writer) cannot persist a duplicate selection.
    if (
      settings.metrics.primary !== undefined &&
      settings.metrics.secondary !== undefined &&
      settings.metrics.primary === settings.metrics.secondary
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'primary and secondary metric must be different',
        path: ['metrics', 'secondary'],
      });
    }
  });

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
