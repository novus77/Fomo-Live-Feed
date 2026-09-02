import { z } from 'zod';

import type { ChainKey } from './activity';
import type { TranslationTarget, UiLocale } from '../i18n/catalog';

/**
 * Metric keys are no longer configurable in settings (LocalSettingsV3 dropped
 * the `metrics` slot), but the type is retained for the event
 * `metricSnapshot.followers` field and for the toast/card cleanup in Task 5.
 */
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
 * V3 removes configurable metrics. Existing events keep their optional
 * `metricSnapshot.followers` for backward compatibility, but the UI no longer
 * shows a metric grid or metric settings.
 */
export interface LocalSettingsV3 {
  schemaVersion: 3;
  notifications: LocalSettingsV1['notifications'];
  filters: {
    mutedChains: ChainKey[];
    minimumUsdAmount?: number;
  };
  uiLocale: UiLocale;
  opinionTranslation: {
    enabled: boolean;
    targetLanguage: TranslationTarget;
  };
}

export type UiTheme = 'light' | 'dark';

export interface LocalSettingsV4 {
  schemaVersion: 4;
  notifications: LocalSettingsV3['notifications'];
  filters: LocalSettingsV3['filters'];
  uiLocale: UiLocale;
  uiTheme: UiTheme;
  opinionTranslation: LocalSettingsV3['opinionTranslation'];
}

export const FINANCIAL_FONT_SIZE_MIN = 11;
export const FINANCIAL_FONT_SIZE_MAX = 18;

export type FinancialTextColor = 'theme' | `#${string}`;

export interface FinancialTextStyle {
  fontSizePx: number;
  color: FinancialTextColor;
}

export interface FinancialDisplaySettings {
  buyAmount: FinancialTextStyle;
  sellAmount: FinancialTextStyle;
  marketCap: FinancialTextStyle;
}

export interface LocalSettingsV5 extends Omit<LocalSettingsV4, 'schemaVersion'> {
  schemaVersion: 5;
  financialDisplay: FinancialDisplaySettings;
}

/**
 * The six supported product chains plus the `unknown` sentinel (Task 3
 * six-chain catalog, spec section 8.1). This is the single chain union for
 * V1/V2/V3 settings: legacy values (e.g. `monad`) are outside the set, so the
 * V1→V2/V3 migration drops muted chains that fall outside it.
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
 * a V1 record containing a legacy value must still parse so the migration can
 * drop that chain instead of discarding the whole record.
 * V2/V3 are strictly the six-chain union (chainKeySchema) and never accept a
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
export const uiThemeSchema = z.enum(['light', 'dark']);

export const metricKeySchema = z.enum([
  'pnl7d',
  'winRate7d',
  'followers',
  'tradeCount',
  'averageHoldSeconds',
]);

/**
 * Single source of truth for the ordered metric keys (retained for event
 * metricSnapshot compatibility and Task 5 toast/card cleanup).
 */
export const METRIC_KEYS: readonly MetricKey[] = metricKeySchema.options;

const notificationsSchema = z.object({
  enabled: z.boolean(),
  maxVisibleToasts: z.literal(3),
  durationMs: z.number().finite().nonnegative(),
  soundEnabled: z.boolean(),
});

// V1/V2 only: the two slots must hold different metrics. V3 has no metrics.
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

export const localSettingsV3Schema = z
  .object({
    schemaVersion: z.literal(3),
    notifications: notificationsSchema,
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
  .passthrough();

export const localSettingsV4Schema = z
  .object({
    schemaVersion: z.literal(4),
    notifications: notificationsSchema,
    filters: z.object({
      mutedChains: z.array(chainKeySchema),
      minimumUsdAmount: z.number().finite().nonnegative().optional(),
    }),
    uiLocale: uiLocaleSchema,
    uiTheme: uiThemeSchema,
    opinionTranslation: z.object({
      enabled: z.boolean(),
      targetLanguage: translationTargetSchema,
    }),
  })
  .passthrough();

const financialTextColorSchema = z.union([
  z.literal('theme'),
  z.string().regex(/^#[0-9a-fA-F]{6}$/),
]);

const financialTextStyleSchema = z.object({
  fontSizePx: z.number().int().min(FINANCIAL_FONT_SIZE_MIN).max(FINANCIAL_FONT_SIZE_MAX),
  color: financialTextColorSchema,
});

export const localSettingsV5Schema = z
  .object({
    schemaVersion: z.literal(5),
    notifications: notificationsSchema,
    filters: z.object({
      mutedChains: z.array(chainKeySchema),
      minimumUsdAmount: z.number().finite().nonnegative().optional(),
    }),
    uiLocale: uiLocaleSchema,
    uiTheme: uiThemeSchema,
    opinionTranslation: z.object({
      enabled: z.boolean(),
      targetLanguage: translationTargetSchema,
    }),
    financialDisplay: z.object({
      buyAmount: financialTextStyleSchema,
      sellAmount: financialTextStyleSchema,
      marketCap: financialTextStyleSchema,
    }),
  })
  .passthrough();

export const DEFAULT_FINANCIAL_DISPLAY: FinancialDisplaySettings = {
  buyAmount: { fontSizePx: 13, color: 'theme' },
  sellAmount: { fontSizePx: 13, color: 'theme' },
  marketCap: { fontSizePx: 13, color: 'theme' },
};

export const DEFAULT_SETTINGS: LocalSettingsV5 = {
  schemaVersion: 5,
  notifications: {
    enabled: true,
    maxVisibleToasts: 3,
    durationMs: 8000,
    soundEnabled: false,
  },
  filters: {
    mutedChains: [],
  },
  uiLocale: 'en',
  uiTheme: 'dark',
  opinionTranslation: {
    enabled: true,
    targetLanguage: 'auto',
  },
  financialDisplay: DEFAULT_FINANCIAL_DISPLAY,
};

export interface LocalSettingsUpdate {
  notifications?: Partial<LocalSettingsV5['notifications']>;
  filters?: Partial<LocalSettingsV5['filters']>;
  uiLocale?: UiLocale;
  uiTheme?: UiTheme;
  opinionTranslation?: Partial<LocalSettingsV5['opinionTranslation']>;
  financialDisplay?: Partial<{
    [K in keyof FinancialDisplaySettings]: Partial<FinancialDisplaySettings[K]>;
  }>;
}
