import { z } from 'zod';

import type { ChainKey } from '../domain/activity';
import {
  ANNOTATION_COLORS,
  MAX_ANNOTATION_LABEL_LENGTH,
  traderAnnotationSchema,
  type AnnotationColor,
  type TraderAnnotationUpdate,
  type TraderAnnotationV1,
} from '../domain/annotations';
import {
  DEFAULT_SETTINGS,
  DEFAULT_FINANCIAL_DISPLAY,
  chainKeySchema,
  localSettingsSchema,
  localSettingsV2Schema,
  localSettingsV3Schema,
  localSettingsV4Schema,
  localSettingsV5Schema,
  type LocalSettingsUpdate,
  type LocalSettingsV1,
  type LocalSettingsV2,
  type LocalSettingsV3,
  type LocalSettingsV4,
  type LocalSettingsV5,
} from '../domain/settings';
import { resolveBrowserLocale, type UiLocale } from '../i18n/catalog';

export const SETTINGS_STORAGE_KEY = 'settings.v5';
export const LEGACY_V4_SETTINGS_STORAGE_KEY = 'settings.v4';
export const LEGACY_V3_SETTINGS_STORAGE_KEY = 'settings.v3';
/**
 * The pre-V3 storage key. It is READ (and migrated) but never deleted in
 * this release so an older extension build can still roll back.
 */
export const LEGACY_SETTINGS_STORAGE_KEY = 'settings.v2';
/**
 * The pre-V2 storage key. It is READ (and migrated) but never deleted in
 * this release so an older extension build can still roll back.
 */
export const LEGACY_V1_SETTINGS_STORAGE_KEY = 'settings.v1';
export const ANNOTATIONS_STORAGE_KEY = 'annotations.v1';

/**
 * Minimal shape of chrome.storage.local required by LocalPreferences, so
 * unit tests can inject an in-memory fake and production code can pass the
 * real storage area.
 */
export interface LocalPreferencesStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const assertTraderId = (traderId: string) => {
  if (typeof traderId !== 'string' || traderId.trim().length === 0) {
    throw new TypeError('traderId must be a non-empty string');
  }
};

const assertTimestamp = (at: number) => {
  if (!isFiniteNonNegativeInteger(at)) {
    throw new TypeError('at must be a finite non-negative integer');
  }
};

const assertMonotonic = (existing: TraderAnnotationV1 | undefined, at: number) => {
  if (existing !== undefined && existing.updatedAt > at) {
    throw new TypeError(
      'updatedAt must be monotonic; at is older than the stored updatedAt',
    );
  }
};

const assertBooleanField = (value: unknown, name: string) => {
  if (typeof value !== 'boolean') {
    throw new TypeError(`${name} must be a boolean`);
  }
};

const normalizeLabel = (label: string): string | undefined => {
  const trimmed = label.trim();

  if (trimmed.length > MAX_ANNOTATION_LABEL_LENGTH) {
    throw new TypeError(
      `label must be at most ${MAX_ANNOTATION_LABEL_LENGTH} characters`,
    );
  }

  // An empty label clears the stored label instead of persisting whitespace.
  return trimmed.length > 0 ? trimmed : undefined;
};

const normalizeColor = (color: string): AnnotationColor => {
  if (!ANNOTATION_COLORS.includes(color as AnnotationColor)) {
    throw new TypeError('color must be one of the exported annotation swatches');
  }

  return color as AnnotationColor;
};

const withoutTombstone = (record: TraderAnnotationV1): TraderAnnotationV1 => {
  const { deletedAt: _deletedAt, ...rest } = record;

  return rest;
};

const applyUpdate = (
  carried: TraderAnnotationV1,
  update: TraderAnnotationUpdate,
): TraderAnnotationV1 => {
  const result: TraderAnnotationV1 = { ...carried };

  if (update.label !== undefined) {
    const label = normalizeLabel(update.label);

    if (label === undefined) {
      delete result.label;
    } else {
      result.label = label;
    }
  }

  if (update.color !== undefined) {
    result.color = normalizeColor(update.color);
  }

  if (update.pinned !== undefined) {
    assertBooleanField(update.pinned, 'pinned');
    result.pinned = update.pinned;
  }

  if (update.muted !== undefined) {
    assertBooleanField(update.muted, 'muted');
    result.muted = update.muted;
  }

  return result;
};

const toLocalSettingsV1 = (
  data: z.infer<typeof localSettingsSchema>,
): LocalSettingsV1 => ({
  schemaVersion: 1,
  notifications: {
    enabled: data.notifications.enabled,
    maxVisibleToasts: 3,
    durationMs: data.notifications.durationMs,
    soundEnabled: data.notifications.soundEnabled,
  },
  metrics: {
    ...(data.metrics.primary !== undefined
      ? { primary: data.metrics.primary }
      : {}),
    ...(data.metrics.secondary !== undefined
      ? { secondary: data.metrics.secondary }
      : {}),
  },
  filters: {
    // The V1 schema tolerates legacy muted chains (e.g. monad) so a legacy
    // record still parses; the runtime LocalSettingsV1 type only carries
    // current ChainKeys, so legacy values are dropped here. The V1→V2
    // migration filters again through chainKeySchema, so this is safe to do
    // at parse time. (The cast is a narrowing: every value that survives the
    // chainKeySchema filter is by definition a ChainKey.)
    mutedChains: data.filters.mutedChains.filter(
      (chain) => chainKeySchema.safeParse(chain).success,
    ) as ChainKey[],
    ...(data.filters.minimumUsdAmount !== undefined
      ? { minimumUsdAmount: data.filters.minimumUsdAmount }
      : {}),
  },
});

const toLocalSettingsV2 = (
  data: z.infer<typeof localSettingsV2Schema>,
): LocalSettingsV2 => ({
  schemaVersion: 2,
  notifications: {
    enabled: data.notifications.enabled,
    maxVisibleToasts: 3,
    durationMs: data.notifications.durationMs,
    soundEnabled: data.notifications.soundEnabled,
  },
  metrics: {
    ...(data.metrics.primary !== undefined
      ? { primary: data.metrics.primary }
      : {}),
    ...(data.metrics.secondary !== undefined
      ? { secondary: data.metrics.secondary }
      : {}),
  },
  filters: {
    mutedChains: data.filters.mutedChains,
    ...(data.filters.minimumUsdAmount !== undefined
      ? { minimumUsdAmount: data.filters.minimumUsdAmount }
      : {}),
  },
  uiLocale: data.uiLocale,
  opinionTranslation: {
    enabled: data.opinionTranslation.enabled,
    targetLanguage: data.opinionTranslation.targetLanguage,
  },
});

const toLocalSettingsV3 = (
  data: z.infer<typeof localSettingsV3Schema>,
): LocalSettingsV3 => ({
  schemaVersion: 3,
  notifications: {
    enabled: data.notifications.enabled,
    maxVisibleToasts: 3,
    durationMs: data.notifications.durationMs,
    soundEnabled: data.notifications.soundEnabled,
  },
  filters: {
    mutedChains: data.filters.mutedChains,
    ...(data.filters.minimumUsdAmount !== undefined
      ? { minimumUsdAmount: data.filters.minimumUsdAmount }
      : {}),
  },
  uiLocale: data.uiLocale,
  opinionTranslation: {
    enabled: data.opinionTranslation.enabled,
    targetLanguage: data.opinionTranslation.targetLanguage,
  },
});

const toLocalSettingsV4 = (
  data: z.infer<typeof localSettingsV4Schema>,
): LocalSettingsV4 => ({
  schemaVersion: 4,
  notifications: {
    enabled: data.notifications.enabled,
    maxVisibleToasts: 3,
    durationMs: data.notifications.durationMs,
    soundEnabled: data.notifications.soundEnabled,
  },
  filters: {
    mutedChains: data.filters.mutedChains,
    ...(data.filters.minimumUsdAmount !== undefined
      ? { minimumUsdAmount: data.filters.minimumUsdAmount }
      : {}),
  },
  uiLocale: data.uiLocale,
  uiTheme: data.uiTheme,
  opinionTranslation: {
    enabled: data.opinionTranslation.enabled,
    targetLanguage: data.opinionTranslation.targetLanguage,
  },
});

const normalizeFinancialColor = (color: string): LocalSettingsV5['financialDisplay']['buyAmount']['color'] =>
  color === 'theme' ? 'theme' : color.toUpperCase() as `#${string}`;

const toLocalSettingsV5 = (
  data: z.infer<typeof localSettingsV5Schema>,
): LocalSettingsV5 => ({
  schemaVersion: 5,
  notifications: {
    enabled: data.notifications.enabled,
    maxVisibleToasts: 3,
    durationMs: data.notifications.durationMs,
    soundEnabled: data.notifications.soundEnabled,
  },
  filters: {
    mutedChains: data.filters.mutedChains,
    ...(data.filters.minimumUsdAmount !== undefined
      ? { minimumUsdAmount: data.filters.minimumUsdAmount }
      : {}),
  },
  uiLocale: data.uiLocale,
  uiTheme: data.uiTheme,
  opinionTranslation: { ...data.opinionTranslation },
  financialDisplay: {
    buyAmount: {
      fontSizePx: data.financialDisplay.buyAmount.fontSizePx,
      color: normalizeFinancialColor(data.financialDisplay.buyAmount.color),
    },
    sellAmount: {
      fontSizePx: data.financialDisplay.sellAmount.fontSizePx,
      color: normalizeFinancialColor(data.financialDisplay.sellAmount.color),
    },
    marketCap: {
      fontSizePx: data.financialDisplay.marketCap.fontSizePx,
      color: normalizeFinancialColor(data.financialDisplay.marketCap.color),
    },
  },
});

const toTraderAnnotation = (
  data: z.infer<typeof traderAnnotationSchema>,
): TraderAnnotationV1 => ({
  traderId: data.traderId,
  ...(data.label !== undefined ? { label: data.label } : {}),
  ...(data.color !== undefined ? { color: data.color } : {}),
  ...(data.pinned !== undefined ? { pinned: data.pinned } : {}),
  ...(data.muted !== undefined ? { muted: data.muted } : {}),
  updatedAt: data.updatedAt,
  ...(data.deletedAt !== undefined ? { deletedAt: data.deletedAt } : {}),
});

/** Valid V3 settings, or null when the value is absent or corrupt. */
const parseV3Settings = (value: unknown): LocalSettingsV3 | null => {
  const parsed = localSettingsV3Schema.safeParse(value);

  return parsed.success ? toLocalSettingsV3(parsed.data) : null;
};

const parseV4Settings = (value: unknown): LocalSettingsV4 | null => {
  const parsed = localSettingsV4Schema.safeParse(value);

  return parsed.success ? toLocalSettingsV4(parsed.data) : null;
};

const parseV5Settings = (value: unknown): LocalSettingsV5 | null => {
  const parsed = localSettingsV5Schema.safeParse(value);
  return parsed.success ? toLocalSettingsV5(parsed.data) : null;
};

/** Valid V2 settings, or null when the value is absent or corrupt. */
const parseV2Settings = (value: unknown): LocalSettingsV2 | null => {
  const parsed = localSettingsV2Schema.safeParse(value);

  return parsed.success ? toLocalSettingsV2(parsed.data) : null;
};

/** Valid V1 settings, or null when the value is absent or corrupt. */
const parseV1Settings = (value: unknown): LocalSettingsV1 | null => {
  const parsed = localSettingsSchema.safeParse(value);

  return parsed.success ? toLocalSettingsV1(parsed.data) : null;
};

const parseAnnotation = (candidate: unknown): TraderAnnotationV1 => {
  const parsed = traderAnnotationSchema.safeParse(candidate);

  if (!parsed.success) {
    throw new TypeError('annotation record failed validation');
  }

  return toTraderAnnotation(parsed.data);
};

const cloneDefaultSettings = (): LocalSettingsV5 => ({
  schemaVersion: 5,
  notifications: { ...DEFAULT_SETTINGS.notifications },
  filters: { ...DEFAULT_SETTINGS.filters },
  uiLocale: DEFAULT_SETTINGS.uiLocale,
  uiTheme: DEFAULT_SETTINGS.uiTheme,
  opinionTranslation: { ...DEFAULT_SETTINGS.opinionTranslation },
  financialDisplay: {
    buyAmount: { ...DEFAULT_SETTINGS.financialDisplay.buyAmount },
    sellAmount: { ...DEFAULT_SETTINGS.financialDisplay.sellAmount },
    marketCap: { ...DEFAULT_SETTINGS.financialDisplay.marketCap },
  },
});

const migrateV4ToV5 = (v4: LocalSettingsV4): LocalSettingsV5 => ({
  ...v4,
  schemaVersion: 5,
  financialDisplay: {
    buyAmount: { ...DEFAULT_FINANCIAL_DISPLAY.buyAmount },
    sellAmount: { ...DEFAULT_FINANCIAL_DISPLAY.sellAmount },
    marketCap: { ...DEFAULT_FINANCIAL_DISPLAY.marketCap },
  },
});

const migrateV3ToV4 = (v3: LocalSettingsV3): LocalSettingsV4 => ({
  ...v3,
  schemaVersion: 4,
  uiTheme: 'dark',
});

const migrateV2ToV4 = (v2: LocalSettingsV2): LocalSettingsV4 => ({
  ...migrateV2ToV3(v2),
  schemaVersion: 4,
  uiTheme: 'dark',
});

const migrateV1ToV4 = (v1: LocalSettingsV1, locale: UiLocale): LocalSettingsV4 => ({
  ...migrateV1ToV3(v1, locale),
  schemaVersion: 4,
  uiTheme: 'dark',
});

/**
 * V2→V3 migration: notifications, filters, UI locale, and opinion-translation
 * preferences are preserved; the configurable `metrics` slot is dropped.
 */
const migrateV2ToV3 = (v2: LocalSettingsV2): LocalSettingsV3 => ({
  schemaVersion: 3,
  notifications: { ...v2.notifications },
  filters: {
    mutedChains: v2.filters.mutedChains.filter((chain) =>
      chainKeySchema.safeParse(chain).success,
    ),
    ...(v2.filters.minimumUsdAmount !== undefined
      ? { minimumUsdAmount: v2.filters.minimumUsdAmount }
      : {}),
  },
  uiLocale: v2.uiLocale,
  opinionTranslation: { ...v2.opinionTranslation },
});

/**
 * V1→V3 migration: every existing field is preserved verbatim, muted chains
 * are filtered to the six-chain union (dropping legacy values such as
 * `monad`), the UI locale is initialized from the injected browser-locale
 * resolver, and the opinion-translation defaults are enabled/auto. The
 * configurable `metrics` slot is dropped.
 */
const migrateV1ToV3 = (v1: LocalSettingsV1, locale: UiLocale): LocalSettingsV3 => ({
  schemaVersion: 3,
  notifications: { ...v1.notifications },
  filters: {
    mutedChains: v1.filters.mutedChains.filter((chain) =>
      chainKeySchema.safeParse(chain).success,
    ),
    ...(v1.filters.minimumUsdAmount !== undefined
      ? { minimumUsdAmount: v1.filters.minimumUsdAmount }
      : {}),
  },
  uiLocale: locale,
  opinionTranslation: {
    enabled: true,
    targetLanguage: 'auto',
  },
});

/**
 * Versioned adapter over chrome.storage.local for settings and trader
 * annotations. Settings persist under `settings.v3`; a missing or corrupt
 * V3 record falls back to the legacy `settings.v2` record (migrating and
 * persisting V3 exactly once), then to `settings.v1` (migrating and
 * persisting V3 exactly once), and finally to the defaults. Legacy records
 * are never deleted so rollback stays recoverable. Every write replaces only
 * its own namespaced key and preserves all other storage keys. Settings
 * updates are serialized through an internal queue so concurrent
 * read-modify-write cycles never overwrite each other. All data read out of
 * storage is runtime-validated with Zod and degrades gracefully (settings
 * fall back to defaults; invalid annotation records are dropped per record)
 * instead of throwing.
 */
export class LocalPreferences {
  /**
   * @param storage chrome.storage.local (or a test fake).
   * @param resolveLocale injected browser-locale resolver used to initialize
   *   `uiLocale` during the V1/V2→V3 migration and for first-run defaults;
   *   defaults to the real browser locale.
   */
  constructor(
    private readonly storage: LocalPreferencesStorage,
    private readonly resolveLocale: () => UiLocale = resolveBrowserLocale,
  ) {}

  /**
   * Serializes `updateSettings` calls: each update is chained onto this
   * promise and runs only after the previous one has fully
   * read-merged-validated-written, so a later update always reads the value
   * written by the earlier one instead of a stale pre-write snapshot. The
   * head promise never rejects — a rejected head would skip every later
   * update chained onto it — so a failed update surfaces to its own caller
   * without blocking the queue. The resolved value is never consumed; only
   * the ordering matters.
   */
  private updateQueue: Promise<unknown> = Promise.resolve();

  async getSettings(): Promise<LocalSettingsV5> {
    const stored = await this.storage.get([
      SETTINGS_STORAGE_KEY,
      LEGACY_V4_SETTINGS_STORAGE_KEY,
      LEGACY_V3_SETTINGS_STORAGE_KEY,
      LEGACY_SETTINGS_STORAGE_KEY,
      LEGACY_V1_SETTINGS_STORAGE_KEY,
    ]);

    const v5 = parseV5Settings(stored[SETTINGS_STORAGE_KEY]);

    if (v5 !== null) {
      return v5;
    }

    const v4 = parseV4Settings(stored[LEGACY_V4_SETTINGS_STORAGE_KEY]);
    if (v4 !== null) {
      const migrated = migrateV4ToV5(v4);
      await this.storage.set({ [SETTINGS_STORAGE_KEY]: migrated });
      return migrated;
    }

    const v3 = parseV3Settings(stored[LEGACY_V3_SETTINGS_STORAGE_KEY]);

    if (v3 !== null) {
      const migrated = migrateV4ToV5(migrateV3ToV4(v3));
      await this.storage.set({ [SETTINGS_STORAGE_KEY]: migrated });
      return migrated;
    }

    // Otherwise migrate a valid legacy V2 record and persist V3 once. A
    // corrupt V3 record therefore still recovers the user's last V2 state;
    // annotation storage is never touched by this path.
    const v2 = parseV2Settings(stored[LEGACY_SETTINGS_STORAGE_KEY]);

    if (v2 !== null) {
      const migrated = migrateV4ToV5(migrateV2ToV4(v2));

      await this.storage.set({ [SETTINGS_STORAGE_KEY]: migrated });

      return migrated;
    }

    // Finally migrate a valid legacy V1 record and persist V3 once.
    const v1 = parseV1Settings(stored[LEGACY_V1_SETTINGS_STORAGE_KEY]);

    if (v1 !== null) {
      const migrated = migrateV4ToV5(migrateV1ToV4(v1, this.resolveLocale()));

      await this.storage.set({ [SETTINGS_STORAGE_KEY]: migrated });

      return migrated;
    }

    // Fresh install (or corrupt V1/V2 too): first-run locale comes from the
    // injected browser-locale resolver.
    return { ...cloneDefaultSettings(), uiLocale: this.resolveLocale() };
  }

  async updateSettings(update: LocalSettingsUpdate): Promise<LocalSettingsV5> {
    const run = this.updateQueue.then(() => this.applyUpdate(update));

    // Swallow the failure for the queue head so a rejected update cannot
    // permanently block subsequent updates; the caller still receives the
    // original rejection from `run`.
    this.updateQueue = run.catch(() => undefined);

    return run;
  }

  /** Read-merge-validate-write for a single queued settings update. */
  private async applyUpdate(
    update: LocalSettingsUpdate,
  ): Promise<LocalSettingsV5> {
    const current = await this.getSettings();

    const merged = {
      ...current,
      schemaVersion: 5,
      notifications: {
        ...current.notifications,
        ...(update.notifications ?? {}),
      },
      filters: {
        ...current.filters,
        ...(update.filters ?? {}),
      },
      ...(update.uiLocale !== undefined ? { uiLocale: update.uiLocale } : {}),
      ...(update.uiTheme !== undefined ? { uiTheme: update.uiTheme } : {}),
      ...(update.opinionTranslation !== undefined
        ? {
            opinionTranslation: {
              ...current.opinionTranslation,
              ...update.opinionTranslation,
            },
          }
        : {}),
      financialDisplay: {
        buyAmount: {
          ...current.financialDisplay.buyAmount,
          ...(update.financialDisplay?.buyAmount ?? {}),
        },
        sellAmount: {
          ...current.financialDisplay.sellAmount,
          ...(update.financialDisplay?.sellAmount ?? {}),
        },
        marketCap: {
          ...current.financialDisplay.marketCap,
          ...(update.financialDisplay?.marketCap ?? {}),
        },
      },
    };

    const parsed = localSettingsV5Schema.safeParse(merged);

    if (!parsed.success) {
      throw new TypeError('settings update failed validation');
    }

    const next = toLocalSettingsV5(parsed.data);
    await this.storage.set({ [SETTINGS_STORAGE_KEY]: next });

    return next;
  }

  async getAnnotation(traderId: string): Promise<TraderAnnotationV1 | undefined> {
    assertTraderId(traderId);

    const map = await this.readAnnotationMap();

    return map[traderId];
  }

  /** Active (non-tombstoned) annotations, sorted by trader ID for determinism. */
  async listAnnotations(): Promise<TraderAnnotationV1[]> {
    const map = await this.readAnnotationMap();

    return Object.values(map)
      .filter((record) => record.deletedAt === undefined)
      .sort((a, b) => a.traderId.localeCompare(b.traderId));
  }

  async upsertAnnotation(
    traderId: string,
    update: TraderAnnotationUpdate,
    at: number,
  ): Promise<TraderAnnotationV1> {
    assertTraderId(traderId);
    assertTimestamp(at);

    const existing = await this.getAnnotation(traderId);
    assertMonotonic(existing, at);

    const carried: TraderAnnotationV1 = existing
      ? withoutTombstone(existing)
      : { traderId, updatedAt: at };

    const next = parseAnnotation({
      ...applyUpdate(carried, update),
      traderId,
      updatedAt: at,
    });

    await this.writeAnnotation(traderId, next);

    return next;
  }

  /**
   * Writes a tombstone instead of removing the record: deletedAt and
   * updatedAt are both set to at so future multi-device conflict resolution
   * can still reconcile this trader's history.
   */
  async deleteAnnotation(traderId: string, at: number): Promise<TraderAnnotationV1> {
    assertTraderId(traderId);
    assertTimestamp(at);

    const existing = await this.getAnnotation(traderId);
    assertMonotonic(existing, at);

    const base: TraderAnnotationV1 = existing
      ? withoutTombstone(existing)
      : { traderId, updatedAt: at };

    const tombstone = parseAnnotation({
      ...base,
      traderId,
      updatedAt: at,
      deletedAt: at,
    });

    await this.writeAnnotation(traderId, tombstone);

    return tombstone;
  }

  private async readAnnotationMap(): Promise<Record<string, TraderAnnotationV1>> {
    const stored = await this.storage.get([ANNOTATIONS_STORAGE_KEY]);
    const raw = stored[ANNOTATIONS_STORAGE_KEY];

    if (!isPlainRecord(raw)) {
      return {};
    }

    const map: Record<string, TraderAnnotationV1> = {};

    for (const value of Object.values(raw)) {
      const parsed = traderAnnotationSchema.safeParse(value);

      if (!parsed.success) {
        continue;
      }

      map[parsed.data.traderId] = toTraderAnnotation(parsed.data);
    }

    return map;
  }

  private async writeAnnotation(
    traderId: string,
    record: TraderAnnotationV1,
  ): Promise<void> {
    const map = await this.readAnnotationMap();

    map[traderId] = record;

    await this.storage.set({ [ANNOTATIONS_STORAGE_KEY]: map });
  }
}
