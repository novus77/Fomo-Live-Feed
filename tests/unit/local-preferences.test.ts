import { describe, expect, it } from 'vitest';

import {
  ANNOTATION_COLORS,
  type AnnotationColor,
} from '../../src/domain/annotations';
import {
  DEFAULT_SETTINGS,
  type LocalSettingsUpdate,
  type LocalSettingsV1,
  type LocalSettingsV2,
} from '../../src/domain/settings';
import { resolveBrowserLocale } from '../../src/i18n/catalog';
import {
  ANNOTATIONS_STORAGE_KEY,
  LEGACY_SETTINGS_STORAGE_KEY,
  LocalPreferences,
  SETTINGS_STORAGE_KEY,
  type LocalPreferencesStorage,
} from '../../src/storage/local-preferences';

class InMemoryStorage implements LocalPreferencesStorage {
  private readonly items = new Map<string, unknown>();
  private sets = 0;

  async get(keys: string[]): Promise<Record<string, unknown>> {
    const result: Record<string, unknown> = {};

    for (const key of keys) {
      if (this.items.has(key)) {
        result[key] = this.items.get(key);
      }
    }

    return result;
  }

  async set(items: Record<string, unknown>): Promise<void> {
    this.sets += 1;

    for (const [key, value] of Object.entries(items)) {
      this.items.set(key, value);
    }
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.items);
  }

  setCount(): number {
    return this.sets;
  }

  /** Drops writes performed by the test harness itself (e.g. seeding). */
  resetSetCount(): void {
    this.sets = 0;
  }
}

/**
 * A complete, valid V1 settings record exercising every field, including a
 * LEGACY muted chain (`monad`) that predates the six-chain catalog. The V1
 * schema stays tolerant of legacy values so the migration can drop them, but
 * `monad` is no longer a ChainKey, so the fixture's mutedChains is typed
 * loosely.
 */
const V1_SETTINGS: Omit<LocalSettingsV1, 'filters'> & {
  filters: { mutedChains: string[]; minimumUsdAmount: number };
} = {
  schemaVersion: 1,
  notifications: {
    enabled: false,
    maxVisibleToasts: 3,
    durationMs: 5000,
    soundEnabled: true,
  },
  metrics: { primary: 'followers', secondary: 'tradeCount' },
  filters: { mutedChains: ['solana', 'monad', 'bsc'], minimumUsdAmount: 50 },
};

const V2_SETTINGS: LocalSettingsV2 = {
  schemaVersion: 2,
  notifications: {
    enabled: true,
    maxVisibleToasts: 3,
    durationMs: 8000,
    soundEnabled: false,
  },
  metrics: { primary: 'pnl7d', secondary: 'winRate7d' },
  filters: { mutedChains: ['ethereum'] },
  uiLocale: 'en',
  opinionTranslation: { enabled: true, targetLanguage: 'auto' },
};

const createHarness = (options: {
  seed?: Record<string, unknown>;
  locale?: 'en' | 'zh-CN';
} = {}) => {
  const storage = new InMemoryStorage();

  if (options.seed !== undefined) {
    void storage.set(options.seed);
  }

  // Seed writes are harness setup, not LocalPreferences writes: setCount()
  // therefore counts only what the adapter itself persisted.
  storage.resetSetCount();

  const preferences =
    options.locale !== undefined
      ? new LocalPreferences(storage, () => options.locale as 'en' | 'zh-CN')
      : new LocalPreferences(storage);

  return { storage, preferences };
};

describe('LocalPreferences settings (V2)', () => {
  it('returns defaults (with the resolved locale) for empty storage without writing', async () => {
    const { storage, preferences } = createHarness({ locale: 'zh-CN' });

    const settings = await preferences.getSettings();

    expect(settings).toEqual({ ...DEFAULT_SETTINGS, uiLocale: 'zh-CN' });
    // A fresh install writes nothing: there is no record to migrate.
    expect(storage.setCount()).toBe(0);
  });

  it('returns the exported defaults for empty storage with an en resolver', async () => {
    const { preferences } = createHarness({ locale: 'en' });

    await expect(preferences.getSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('uses the real browser locale by default', async () => {
    const { preferences } = createHarness();

    expect((await preferences.getSettings()).uiLocale).toBe(
      resolveBrowserLocale(),
    );
  });

  it('migrates a valid V1 record: preserves fields, drops legacy muted chains, initializes locale and translation defaults', async () => {
    const { storage, preferences } = createHarness({
      seed: { [LEGACY_SETTINGS_STORAGE_KEY]: V1_SETTINGS },
      locale: 'zh-CN',
    });

    const settings = await preferences.getSettings();

    expect(settings).toEqual({
      schemaVersion: 2,
      notifications: V1_SETTINGS.notifications,
      metrics: V1_SETTINGS.metrics,
      filters: {
        // monad is outside the six-chain union and is dropped; solana and bsc
        // are preserved with the rest of the record.
        mutedChains: ['solana', 'bsc'],
        minimumUsdAmount: 50,
      },
      uiLocale: 'zh-CN',
      opinionTranslation: { enabled: true, targetLanguage: 'auto' },
    });

    // V2 is persisted once under settings.v2 and V1 is left intact.
    expect(storage.snapshot()).toMatchObject({
      [SETTINGS_STORAGE_KEY]: settings,
      [LEGACY_SETTINGS_STORAGE_KEY]: V1_SETTINGS,
    });
  });

  it('migrates and writes V2 exactly once across repeated reads', async () => {
    const { storage, preferences } = createHarness({
      seed: { [LEGACY_SETTINGS_STORAGE_KEY]: V1_SETTINGS },
      locale: 'en',
    });

    await preferences.getSettings();
    const setsAfterFirstRead = storage.setCount();

    await preferences.getSettings();
    await preferences.getSettings();

    expect(storage.setCount()).toBe(setsAfterFirstRead);
  });

  it('preserves every still-supported muted chain and drops only legacy ones', async () => {
    const { preferences } = createHarness({
      seed: {
        [LEGACY_SETTINGS_STORAGE_KEY]: {
          ...V1_SETTINGS,
          filters: {
            ...V1_SETTINGS.filters,
            mutedChains: [
              'solana',
              'ethereum',
              'bsc',
              'base',
              'monad',
              'unknown',
            ],
          },
        },
      },
      locale: 'en',
    });

    const settings = await preferences.getSettings();

    expect(settings.filters.mutedChains).toEqual([
      'solana',
      'ethereum',
      'bsc',
      'base',
      'unknown',
    ]);
  });

  it('reads a valid V2 record first and never re-migrates V1', async () => {
    const { storage, preferences } = createHarness({
      seed: {
        [SETTINGS_STORAGE_KEY]: V2_SETTINGS,
        [LEGACY_SETTINGS_STORAGE_KEY]: V1_SETTINGS,
      },
      locale: 'zh-CN',
    });

    const settings = await preferences.getSettings();

    // V2 is authoritative: its own locale and filters win over V1's.
    expect(settings).toEqual(V2_SETTINGS);
    expect(storage.snapshot()[LEGACY_SETTINGS_STORAGE_KEY]).toEqual(V1_SETTINGS);
    expect(storage.setCount()).toBe(0);
  });

  it('recovers a corrupt V2 record from a valid V1 record', async () => {
    const { storage, preferences } = createHarness({
      seed: {
        [SETTINGS_STORAGE_KEY]: { schemaVersion: 2, uiLocale: 42 },
        [LEGACY_SETTINGS_STORAGE_KEY]: V1_SETTINGS,
      },
      locale: 'en',
    });

    const settings = await preferences.getSettings();

    expect(settings).toMatchObject({
      schemaVersion: 2,
      uiLocale: 'en',
      opinionTranslation: { enabled: true, targetLanguage: 'auto' },
    });
    // The corrupt V2 record was replaced by the migrated V1 state.
    expect(storage.snapshot()[SETTINGS_STORAGE_KEY]).toEqual(settings);
  });

  it('falls back to defaults when both stored records are corrupt', async () => {
    const { storage, preferences } = createHarness({
      seed: {
        [SETTINGS_STORAGE_KEY]: 'not-an-object',
        [LEGACY_SETTINGS_STORAGE_KEY]: { schemaVersion: 1, filters: 'nope' },
      },
      locale: 'zh-CN',
    });

    await expect(preferences.getSettings()).resolves.toEqual({
      ...DEFAULT_SETTINGS,
      uiLocale: 'zh-CN',
    });
    expect(storage.setCount()).toBe(0);
  });

  it('falls back for a V2 record with a legacy muted chain (outside the union)', async () => {
    const { preferences } = createHarness({
      seed: {
        [SETTINGS_STORAGE_KEY]: {
          ...V2_SETTINGS,
          filters: { mutedChains: ['monad'] },
        },
      },
      locale: 'en',
    });

    // monad is outside the six-chain union, so the V2 record is corrupt and
    // the read falls back to defaults instead of surfacing an invalid chain.
    await expect(preferences.getSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('does not delete annotation storage when V2 is corrupt', async () => {
    const { storage, preferences } = createHarness({
      seed: {
        [SETTINGS_STORAGE_KEY]: 'corrupt',
        [LEGACY_SETTINGS_STORAGE_KEY]: V1_SETTINGS,
        [ANNOTATIONS_STORAGE_KEY]: {
          'trader-1': { traderId: 'trader-1', label: 'Whale', updatedAt: 100 },
        },
      },
      locale: 'en',
    });

    await preferences.getSettings();

    expect(storage.snapshot()[ANNOTATIONS_STORAGE_KEY]).toEqual({
      'trader-1': { traderId: 'trader-1', label: 'Whale', updatedAt: 100 },
    });
    await expect(preferences.getAnnotation('trader-1')).resolves.toMatchObject({
      label: 'Whale',
    });
  });

  it('deep-merges partial settings updates without clobbering unrelated fields', async () => {
    const { preferences } = createHarness({ locale: 'en' });

    await preferences.updateSettings({ notifications: { durationMs: 5000 } });

    expect(await preferences.getSettings()).toMatchObject({
      notifications: {
        enabled: true,
        maxVisibleToasts: 3,
        durationMs: 5000,
        soundEnabled: false,
      },
      metrics: { primary: 'pnl7d', secondary: 'winRate7d' },
      filters: { mutedChains: [] },
      uiLocale: 'en',
      opinionTranslation: { enabled: true, targetLanguage: 'auto' },
    });

    await preferences.updateSettings({
      metrics: { primary: 'followers' },
      filters: { minimumUsdAmount: 10 },
      uiLocale: 'zh-CN',
      opinionTranslation: { targetLanguage: 'zh' },
    });

    expect(await preferences.getSettings()).toMatchObject({
      notifications: { durationMs: 5000 },
      metrics: { primary: 'followers', secondary: 'winRate7d' },
      filters: { mutedChains: [], minimumUsdAmount: 10 },
      uiLocale: 'zh-CN',
      opinionTranslation: { enabled: true, targetLanguage: 'zh' },
    });
  });

  it('serializes concurrent updates to different nested fields so none is lost', async () => {
    const { preferences } = createHarness({ locale: 'en' });

    // Fire several updates before awaiting any of them: without the internal
    // queue, every read would see the same pre-write snapshot and each write
    // would clobber the previous update.
    const pending = [
      preferences.updateSettings({ uiLocale: 'zh-CN' }),
      preferences.updateSettings({ notifications: { durationMs: 5000 } }),
      preferences.updateSettings({ metrics: { primary: 'followers' } }),
      preferences.updateSettings({ filters: { minimumUsdAmount: 10 } }),
      preferences.updateSettings({
        opinionTranslation: { targetLanguage: 'zh' },
      }),
    ];

    await Promise.all(pending);

    expect(await preferences.getSettings()).toMatchObject({
      uiLocale: 'zh-CN',
      notifications: {
        enabled: true,
        maxVisibleToasts: 3,
        durationMs: 5000,
        soundEnabled: false,
      },
      metrics: { primary: 'followers', secondary: 'winRate7d' },
      filters: { mutedChains: [], minimumUsdAmount: 10 },
      opinionTranslation: { enabled: true, targetLanguage: 'zh' },
    });
  });

  it('serializes concurrent updates to different fields of the SAME nested object so none is lost', async () => {
    const { preferences } = createHarness({ locale: 'en' });

    // Two concurrent updates touch DIFFERENT fields of the SAME nested
    // object. Without the queue, both reads see the same pre-write snapshot
    // and each write replaces the whole settings.v2 record, so the second
    // write clobbers the first's change; with the queue the second update
    // reads the first's write and both changes survive.
    const pending = [
      preferences.updateSettings({ notifications: { durationMs: 5000 } }),
      preferences.updateSettings({ notifications: { enabled: false } }),
      preferences.updateSettings({ opinionTranslation: { targetLanguage: 'zh' } }),
      preferences.updateSettings({ opinionTranslation: { enabled: false } }),
    ];

    await Promise.all(pending);

    expect(await preferences.getSettings()).toMatchObject({
      notifications: {
        enabled: false,
        maxVisibleToasts: 3,
        durationMs: 5000,
        soundEnabled: false,
      },
      opinionTranslation: { enabled: false, targetLanguage: 'zh' },
    });
  });

  it('surfaces a rejected update to its caller without blocking later updates', async () => {
    const { preferences } = createHarness({ locale: 'en' });

    // A duplicate primary/secondary metric fails the schema; it is fired
    // concurrently with a valid update, so the queue must swallow the
    // failure for its head while still delivering the rejection to the
    // caller and letting the valid update run afterwards.
    const rejected = preferences.updateSettings({
      metrics: { primary: 'winRate7d' },
    });
    const accepted = preferences.updateSettings({ uiLocale: 'zh-CN' });

    await expect(rejected).rejects.toThrow(TypeError);
    await expect(accepted).resolves.toMatchObject({ uiLocale: 'zh-CN' });

    expect(await preferences.getSettings()).toMatchObject({
      uiLocale: 'zh-CN',
      metrics: { primary: 'pnl7d', secondary: 'winRate7d' },
    });
  });

  it('rejects a duplicate primary/secondary metric at the storage schema (NIT)', async () => {
    const { storage, preferences } = createHarness({ locale: 'en' });

    await expect(
      preferences.updateSettings({ metrics: { primary: 'winRate7d' } }),
    ).rejects.toThrowError(TypeError);

    await expect(preferences.getSettings()).resolves.toMatchObject({
      metrics: { primary: 'pnl7d', secondary: 'winRate7d' },
    });
    expect(storage.snapshot()[SETTINGS_STORAGE_KEY]).toBeUndefined();
  });

  it('rejects settings updates that violate the persisted schema', async () => {
    const { preferences } = createHarness({ locale: 'en' });

    await expect(
      preferences.updateSettings({
        notifications: { maxVisibleToasts: 4 },
      } as unknown as LocalSettingsUpdate),
    ).rejects.toThrow(TypeError);

    await expect(
      preferences.updateSettings({ notifications: { durationMs: -1 } }),
    ).rejects.toThrow(TypeError);

    await expect(
      preferences.updateSettings({ uiLocale: 'fr' as 'en' | 'zh-CN' }),
    ).rejects.toThrow(TypeError);

    // A legacy muted chain cannot be persisted into V2 settings.
    await expect(
      preferences.updateSettings({
        filters: { mutedChains: ['monad'] },
      } as unknown as LocalSettingsUpdate),
    ).rejects.toThrow(TypeError);

    await expect(preferences.getSettings()).resolves.toEqual(DEFAULT_SETTINGS);
  });

  it('writes only settings.v2 and preserves every other storage key', async () => {
    const { storage, preferences } = createHarness({ locale: 'en' });

    await storage.set({ 'other.key': { keep: true } });
    await preferences.updateSettings({ notifications: { enabled: false } });

    expect(storage.snapshot()).toMatchObject({
      [SETTINGS_STORAGE_KEY]: {
        schemaVersion: 2,
        notifications: { enabled: false },
      },
      'other.key': { keep: true },
    });
    expect(Object.keys(storage.snapshot()).sort()).toEqual(
      [SETTINGS_STORAGE_KEY, 'other.key'].sort(),
    );
  });
});

describe('LocalPreferences annotations', () => {
  it('stores annotation tombstones by stable trader ID', async () => {
    const { preferences } = createHarness();

    await preferences.deleteAnnotation('trader-1', 5000);

    expect(await preferences.getAnnotation('trader-1')).toMatchObject({
      traderId: 'trader-1',
      deletedAt: 5000,
      updatedAt: 5000,
    });
  });

  it('upserts and merges partial annotation updates', async () => {
    const { preferences } = createHarness();

    await preferences.upsertAnnotation(
      'trader-1',
      { label: 'Whale', color: '#22c55e', pinned: true },
      100,
    );
    await preferences.upsertAnnotation('trader-1', { muted: true }, 200);

    expect(await preferences.getAnnotation('trader-1')).toEqual({
      traderId: 'trader-1',
      label: 'Whale',
      color: '#22c55e',
      pinned: true,
      muted: true,
      updatedAt: 200,
    });
  });

  it('trims labels and clears a label with an empty string', async () => {
    const { preferences } = createHarness();

    await preferences.upsertAnnotation('trader-1', { label: '  Whale  ' }, 100);
    expect((await preferences.getAnnotation('trader-1'))?.label).toBe('Whale');

    await preferences.upsertAnnotation('trader-1', { label: '   ' }, 200);
    const cleared = await preferences.getAnnotation('trader-1');

    expect(cleared).not.toHaveProperty('label');
  });

  it('rejects labels longer than 40 characters', async () => {
    const { preferences } = createHarness();

    await expect(
      preferences.upsertAnnotation('trader-1', { label: 'x'.repeat(41) }, 100),
    ).rejects.toThrow(TypeError);
  });

  it('rejects colors outside the exported allowlist', async () => {
    const { preferences } = createHarness();

    await expect(
      preferences.upsertAnnotation(
        'trader-1',
        { color: '#123456' as AnnotationColor },
        100,
      ),
    ).rejects.toThrow(TypeError);
  });

  it('accepts every exported annotation color swatch', async () => {
    const { preferences } = createHarness();

    for (const [index, color] of ANNOTATION_COLORS.entries()) {
      await preferences.upsertAnnotation('trader-' + index, { color }, 100);
    }

    const colors = (await preferences.listAnnotations()).map(
      (record) => record.color,
    );

    expect(colors).toEqual([...ANNOTATION_COLORS]);
  });

  it('excludes tombstoned annotations from listAnnotations but keeps them readable', async () => {
    const { preferences } = createHarness();

    await preferences.upsertAnnotation('trader-1', { label: 'Alpha' }, 100);
    await preferences.upsertAnnotation('trader-2', { label: 'Beta' }, 200);
    await preferences.deleteAnnotation('trader-1', 300);

    await expect(preferences.listAnnotations()).resolves.toEqual([
      expect.objectContaining({ traderId: 'trader-2' }),
    ]);

    expect(await preferences.getAnnotation('trader-1')).toMatchObject({
      deletedAt: 300,
      updatedAt: 300,
    });
  });

  it('revives a tombstoned annotation on upsert', async () => {
    const { preferences } = createHarness();

    await preferences.deleteAnnotation('trader-1', 100);
    await preferences.upsertAnnotation('trader-1', { muted: true }, 200);

    const revived = await preferences.getAnnotation('trader-1');

    expect(revived).toMatchObject({
      traderId: 'trader-1',
      muted: true,
      updatedAt: 200,
    });
    expect(revived).not.toHaveProperty('deletedAt');
  });

  it('enforces monotonic updatedAt per record', async () => {
    const { preferences } = createHarness();

    await preferences.upsertAnnotation('trader-1', { label: 'one' }, 100);

    await expect(
      preferences.upsertAnnotation('trader-1', { label: 'two' }, 50),
    ).rejects.toThrow(TypeError);
    await expect(
      preferences.deleteAnnotation('trader-1', 90),
    ).rejects.toThrow(TypeError);

    await preferences.deleteAnnotation('trader-1', 200);
    await expect(
      preferences.upsertAnnotation('trader-1', { label: 'three' }, 150),
    ).rejects.toThrow(TypeError);
  });

  it('drops invalid annotation records per record while keeping valid ones', async () => {
    const { storage, preferences } = createHarness();

    await storage.set({
      [ANNOTATIONS_STORAGE_KEY]: {
        'trader-1': { traderId: 'trader-1', label: 'ok', updatedAt: 100 },
        'trader-2': {
          traderId: 'trader-2',
          label: 'x'.repeat(41),
          updatedAt: 100,
        },
        'trader-3': 'not-an-object',
        'trader-4': { traderId: 'trader-4', updatedAt: -5 },
      },
    });

    await expect(preferences.getAnnotation('trader-1')).resolves.toMatchObject({
      traderId: 'trader-1',
    });
    await expect(preferences.getAnnotation('trader-2')).resolves.toBeUndefined();
    await expect(preferences.getAnnotation('trader-3')).resolves.toBeUndefined();
    await expect(preferences.getAnnotation('trader-4')).resolves.toBeUndefined();
  });

  it('treats a non-object annotations value as an empty store', async () => {
    const { storage, preferences } = createHarness();

    await storage.set({ [ANNOTATIONS_STORAGE_KEY]: ['not', 'a', 'map'] });

    await expect(preferences.getAnnotation('trader-1')).resolves.toBeUndefined();
    await expect(preferences.listAnnotations()).resolves.toEqual([]);
  });

  it('keys annotations by stable trader ID rather than handle', async () => {
    const { preferences } = createHarness();

    await preferences.upsertAnnotation('trader-1', { label: 'Alpha' }, 100);
    await preferences.upsertAnnotation('trader-2', { label: 'Beta' }, 200);

    expect(await preferences.getAnnotation('trader-1')).toMatchObject({
      label: 'Alpha',
    });
    expect(await preferences.getAnnotation('trader-2')).toMatchObject({
      label: 'Beta',
    });
  });

  it('writes only annotations.v1 and preserves every other storage key', async () => {
    const { storage, preferences } = createHarness();

    await storage.set({
      [SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS,
      'other.key': { keep: true },
    });

    await preferences.upsertAnnotation('trader-1', { label: 'Alpha' }, 100);
    await preferences.deleteAnnotation('trader-2', 200);

    const snapshot = storage.snapshot();

    expect(snapshot).toMatchObject({
      [SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS,
      'other.key': { keep: true },
    });
    expect(Object.keys(snapshot).sort()).toEqual(
      [ANNOTATIONS_STORAGE_KEY, SETTINGS_STORAGE_KEY, 'other.key'].sort(),
    );
  });
});
