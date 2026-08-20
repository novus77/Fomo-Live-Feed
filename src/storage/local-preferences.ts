import { z } from 'zod';

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
  localSettingsSchema,
  type LocalSettingsUpdate,
  type LocalSettingsV1,
} from '../domain/settings';

export const SETTINGS_STORAGE_KEY = 'settings.v1';
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

const toLocalSettings = (
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
    mutedChains: data.filters.mutedChains,
    ...(data.filters.minimumUsdAmount !== undefined
      ? { minimumUsdAmount: data.filters.minimumUsdAmount }
      : {}),
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

const parseSettings = (value: unknown): LocalSettingsV1 => {
  const parsed = localSettingsSchema.safeParse(value);

  return parsed.success ? toLocalSettings(parsed.data) : cloneDefaultSettings();
};

const parseAnnotation = (candidate: unknown): TraderAnnotationV1 => {
  const parsed = traderAnnotationSchema.safeParse(candidate);

  if (!parsed.success) {
    throw new TypeError('annotation record failed validation');
  }

  return toTraderAnnotation(parsed.data);
};

const cloneDefaultSettings = (): LocalSettingsV1 => ({
  schemaVersion: 1,
  notifications: { ...DEFAULT_SETTINGS.notifications },
  metrics: { ...DEFAULT_SETTINGS.metrics },
  filters: { ...DEFAULT_SETTINGS.filters },
});

/**
 * Versioned adapter over chrome.storage.local for settings and trader
 * annotations. Every write replaces only its own namespaced key
 * (settings.v1 / annotations.v1) and preserves all other storage keys.
 * All data read out of storage is runtime-validated with Zod and degrades
 * gracefully (settings fall back to defaults; invalid annotation records are
 * dropped per record) instead of throwing.
 */
export class LocalPreferences {
  constructor(private readonly storage: LocalPreferencesStorage) {}

  async getSettings(): Promise<LocalSettingsV1> {
    const stored = await this.storage.get([SETTINGS_STORAGE_KEY]);

    return parseSettings(stored[SETTINGS_STORAGE_KEY]);
  }

  async updateSettings(update: LocalSettingsUpdate): Promise<LocalSettingsV1> {
    const current = await this.getSettings();

    const merged = {
      ...current,
      schemaVersion: 1,
      notifications: {
        ...current.notifications,
        ...(update.notifications ?? {}),
      },
      metrics: {
        ...current.metrics,
        ...(update.metrics ?? {}),
      },
      filters: {
        ...current.filters,
        ...(update.filters ?? {}),
      },
    };

    const parsed = localSettingsSchema.safeParse(merged);

    if (!parsed.success) {
      throw new TypeError('settings update failed validation');
    }

    const next = toLocalSettings(parsed.data);
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
