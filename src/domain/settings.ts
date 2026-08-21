import { z } from 'zod';

import type { ChainKey } from './activity';
import type { TranslationTarget, UiLocale } from '../i18n/catalog';

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

export interface LocalSettingsV2 {
  schemaVersion: 2;
  notifications: LocalSettingsV1['notifications'];
  metrics: LocalSettingsV1['metrics'];
  filters: LocalSettingsV1['filters'];
  uiLocale: UiLocale;
  opinionTranslation: {
    enabled: boolean;
    targetLanguage: TranslationTarget;
  };
}

/**
 * The six supported product chains plus the `unknown` sentinel (Task 3
 * six-chain catalog, spec section 8.1). This is the single chain union for
 * both V1 and V2 settings: legacy values (e.g. `monad`) are outside the
 * set, so the V1→V2 migration drops muted chains that fall outside it.
 */
const CHAIN_KEYS = [
  'bsc',
  'solana',
  'robinhood',
  'base',
  'ethereum',
  'x-layer',
  'unknown',
] as const satisfies readonly ChainKey[];

export const chainKeySchema = z.enum(CHAIN_KEYS);

/**
 * Legacy muted-chain values that existed in V1 storage before the six-chain
 * catalog (e.g. `monad`). The V1 schema stays tolerant of them on purpose:
 * a V1 record containing a legacy value must still parse so the V1→V2
 * migration can drop that chain instead of discarding the whole record.
 * V2 is strictly the six-chain union (chainKeySchema) and never accepts a
 * legacy value.
 */
const V1_CHAIN_KEYS = [
  'solana',
  'ethereum',
  'bsc',
  'base',
  'monad',
  'unknown',
] as const;

const v1ChainKeySchema = z.enum(V1_CHAIN_KEYS);

export const uiLocaleSchema = z.enum(['en', 'zh-CN']);
export const translationTargetSchema = z.enum(['auto', 'zh', 'en']);

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

const notificationsSchema = z.object({
  enabled: z.boolean(),
  maxVisibleToasts: z.literal(3),
  durationMs: z.number().finite().nonnegative(),
  soundEnabled: z.boolean(),
});

// The two slots must hold different metrics. The SettingsPanel already
// rejects a duplicate selection, but enforcing it here means a corrupt or
// foreign write cannot persist a state that renders the same metric twice:
// a duplicate fails validation, so getSettings falls back to the defaults.
const metricsSchema = z
  .object({
    primary: metricKeySchema.optional(),
    secondary: metricKeySchema.optional(),
  })
  .refine(
    (metrics) =>
      metrics.primary === undefined ||
      metrics.secondary === undefined ||
      metrics.primary !== metrics.secondary,
    { message: 'primary and secondary metrics must differ' },
  );

const rejectDuplicateMetrics = (
  settings: {
    metrics: {
      primary?: MetricKey | undefined;
      secondary?: MetricKey | undefined;
    };
  },
  ctx: z.RefinementCtx,
): void => {
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
};

export const localSettingsSchema = z
  .object({
    schemaVersion: z.literal(1),
    notifications: notificationsSchema,
    metrics: metricsSchema,
    filters: z.object({
      // V1 records predate the six-chain catalog and may carry legacy muted
      // chain values; the V1 schema accepts them so the migration can drop
      // them (see v1ChainKeySchema above).
      mutedChains: z.array(v1ChainKeySchema),
      minimumUsdAmount: z.number().finite().nonnegative().optional(),
    }),
  })
  .passthrough()
  .superRefine(rejectDuplicateMetrics);

export const localSettingsV2Schema = z
  .object({
    schemaVersion: z.literal(2),
    notifications: notificationsSchema,
    metrics: metricsSchema,
    filters: z.object({
      mutedChains: z.array(chainKeySchema),
      minimumUsdAmount: z.number().finite().nonnegative().optional(),
    }),
    uiLocale: uiLocaleSchema,
    opinionTranslation: z.object({
      enabled: z.boolean(),
      targetLanguage: translationTargetSchema,
    }),
  })
  .passthrough()
  .superRefine(rejectDuplicateMetrics);

export const DEFAULT_SETTINGS: LocalSettingsV2 = {
  schemaVersion: 2,
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
  uiLocale: 'en',
  opinionTranslation: {
    enabled: true,
    targetLanguage: 'auto',
  },
};

export interface LocalSettingsUpdate {
  notifications?: Partial<LocalSettingsV2['notifications']>;
  metrics?: Partial<LocalSettingsV2['metrics']>;
  filters?: Partial<LocalSettingsV2['filters']>;
  uiLocale?: UiLocale;
  opinionTranslation?: Partial<LocalSettingsV2['opinionTranslation']>;
}
