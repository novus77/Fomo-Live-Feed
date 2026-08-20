import { describe, expect, it } from 'vitest';

import {
  ANNOTATION_COLORS,
  type AnnotationColor,
} from '../../src/domain/annotations';
import {
  DEFAULT_SETTINGS,
  type LocalSettingsUpdate,
} from '../../src/domain/settings';
import {
  ANNOTATIONS_STORAGE_KEY,
  LocalPreferences,
  SETTINGS_STORAGE_KEY,
  type LocalPreferencesStorage,
} from '../../src/storage/local-preferences';

class InMemoryStorage implements LocalPreferencesStorage {
  private readonly items = new Map<string, unknown>();

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
    for (const [key, value] of Object.entries(items)) {
      this.items.set(key, value);
    }
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.items);
  }
}

const createHarness = () => {
  const storage = new InMemoryStorage();

  return {
    storage,
    preferences: new LocalPreferences(storage),
  };
};

describe('LocalPreferences', () => {
  describe('settings', () => {
    it('creates MVP defaults for empty storage', async () => {
      const { preferences } = createHarness();

      expect(await preferences.getSettings()).toMatchObject({
        schemaVersion: 1,
        notifications: {
          enabled: true,
          maxVisibleToasts: 3,
          durationMs: 8000,
        },
        metrics: {
          primary: 'pnl7d',
          secondary: 'winRate7d',
        },
      });
    });

    it('returns the exported MVP defaults for empty storage', async () => {
      const { preferences } = createHarness();

      await expect(preferences.getSettings()).resolves.toEqual(DEFAULT_SETTINGS);
    });

    it('deep-merges partial settings updates without clobbering unrelated fields', async () => {
      const { preferences } = createHarness();

      await preferences.updateSettings({
        notifications: { durationMs: 5000 },
      });

      expect(await preferences.getSettings()).toMatchObject({
        notifications: {
          enabled: true,
          maxVisibleToasts: 3,
          durationMs: 5000,
          soundEnabled: false,
        },
        metrics: {
          primary: 'pnl7d',
          secondary: 'winRate7d',
        },
        filters: {
          mutedChains: [],
        },
      });

      await preferences.updateSettings({
        metrics: { primary: 'followers' },
        filters: { minimumUsdAmount: 10 },
      });

      expect(await preferences.getSettings()).toMatchObject({
        notifications: {
          enabled: true,
          maxVisibleToasts: 3,
          durationMs: 5000,
          soundEnabled: false,
        },
        metrics: {
          primary: 'followers',
          secondary: 'winRate7d',
        },
        filters: {
          mutedChains: [],
          minimumUsdAmount: 10,
        },
      });
    });

    it('rejects a duplicate primary/secondary metric at the storage schema (NIT)', async () => {
      const { preferences } = createHarness();

      await expect(
        preferences.updateSettings({
          metrics: { primary: 'winRate7d' },
        }),
      ).rejects.toThrowError(TypeError);

      // The stored record is untouched: defaults survive.
      await expect(preferences.getSettings()).resolves.toMatchObject({
        metrics: { primary: 'pnl7d', secondary: 'winRate7d' },
      });
    });

    it('rejects settings updates that violate the persisted schema', async () => {
      const { preferences } = createHarness();

      await expect(
        preferences.updateSettings({
          notifications: { maxVisibleToasts: 4 },
        } as unknown as LocalSettingsUpdate),
      ).rejects.toThrow(TypeError);

      await expect(
        preferences.updateSettings({ notifications: { durationMs: -1 } }),
      ).rejects.toThrow(TypeError);

      await expect(preferences.getSettings()).resolves.toEqual(DEFAULT_SETTINGS);
    });

    it('falls back to defaults when both metric slots hold the same key', async () => {
      const { storage, preferences } = createHarness();

      // The SettingsPanel rejects a duplicate selection, so this state can only
      // arrive from a corrupt or foreign write. It must not survive validation
      // and render the same metric twice.
      await storage.set({
        [SETTINGS_STORAGE_KEY]: {
          ...DEFAULT_SETTINGS,
          metrics: { primary: 'pnl7d', secondary: 'pnl7d' },
        },
      });

      await expect(preferences.getSettings()).resolves.toEqual(DEFAULT_SETTINGS);
    });

    it('keeps distinct metric slots and a single configured slot', async () => {
      const { storage, preferences } = createHarness();

      await storage.set({
        [SETTINGS_STORAGE_KEY]: {
          ...DEFAULT_SETTINGS,
          metrics: { primary: 'followers', secondary: 'tradeCount' },
        },
      });
      await expect(preferences.getSettings()).resolves.toMatchObject({
        metrics: { primary: 'followers', secondary: 'tradeCount' },
      });

      await storage.set({
        [SETTINGS_STORAGE_KEY]: {
          ...DEFAULT_SETTINGS,
          metrics: { primary: 'pnl7d' },
        },
      });
      await expect(preferences.getSettings()).resolves.toMatchObject({
        metrics: { primary: 'pnl7d' },
      });
    });

    it('falls back to defaults when stored settings are malformed', async () => {
      const { storage, preferences } = createHarness();

      await storage.set({ [SETTINGS_STORAGE_KEY]: 'not-an-object' });
      await expect(preferences.getSettings()).resolves.toEqual(DEFAULT_SETTINGS);

      await storage.set({
        [SETTINGS_STORAGE_KEY]: {
          schemaVersion: 1,
          notifications: {
            enabled: true,
            maxVisibleToasts: 4,
            durationMs: 8000,
            soundEnabled: false,
          },
          metrics: { primary: 'pnl7d' },
          filters: { mutedChains: [] },
        },
      });
      await expect(preferences.getSettings()).resolves.toEqual(DEFAULT_SETTINGS);

      await storage.set({
        [SETTINGS_STORAGE_KEY]: {
          schemaVersion: 1,
          notifications: {
            enabled: true,
            maxVisibleToasts: 3,
            durationMs: 8000,
            soundEnabled: false,
          },
          metrics: { primary: 'pnl7d' },
          filters: { mutedChains: ['not-a-chain'] },
        },
      });
      await expect(preferences.getSettings()).resolves.toEqual(DEFAULT_SETTINGS);
    });

    it('writes only settings.v1 and preserves every other storage key', async () => {
      const { storage, preferences } = createHarness();

      await storage.set({ 'other.key': { keep: true } });
      await preferences.updateSettings({ notifications: { enabled: false } });

      expect(storage.snapshot()).toMatchObject({
        [SETTINGS_STORAGE_KEY]: {
          schemaVersion: 1,
          notifications: { enabled: false },
        },
        'other.key': { keep: true },
      });
    });
  });

  describe('annotations', () => {
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
});
