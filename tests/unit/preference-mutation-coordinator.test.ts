import { describe, expect, it, vi } from 'vitest';

import type { LocalSettingsUpdate, LocalSettingsV6 } from '../../src/domain/settings';
import type { TraderAnnotationUpdate, TraderAnnotationV1 } from '../../src/domain/annotations';
import {
  PreferenceMutationCoordinator,
  type PreferenceMutationPreferences,
} from '../../src/background/preference-mutations';

const settings = (): LocalSettingsV6 => ({
  schemaVersion: 6,
  notifications: { enabled: true, maxVisibleToasts: 3, durationMs: 8_000, soundEnabled: false },
  filters: { mutedChains: [] },
  uiLocale: 'en',
  uiTheme: 'dark',
  opinionTranslation: { enabled: true, targetLanguage: 'auto' },
  financialDisplay: {
    buyAmount: { fontSizePx: 13, color: 'theme' },
    sellAmount: { fontSizePx: 13, color: 'theme' },
    marketCap: { fontSizePx: 13, color: 'theme' },
  },
  displayMode: 'sidepanel',
});

describe('PreferenceMutationCoordinator', () => {
  it('returns a durable receipt when the same settings mutation is retried', async () => {
    const records: Record<string, unknown> = {};
    const preferences: PreferenceMutationPreferences = {
      updateSettings: vi.fn(async (_update: LocalSettingsUpdate) => settings()),
      upsertAnnotation: vi.fn(),
      deleteAnnotation: vi.fn(),
    };
    const coordinator = new PreferenceMutationCoordinator({
      preferences,
      storage: {
        get: async (keys) => Object.fromEntries(keys
          .filter((key) => key in records)
          .map((key) => [key, records[key]])),
        set: async (items) => { Object.assign(records, items); },
      },
    });

    const mutation = {
      mutationId: 'settings-theme-1',
      type: 'settings' as const,
      update: { uiTheme: 'light' as const },
    };
    const first = await coordinator.mutate(mutation);
    const second = await coordinator.mutate(mutation);

    expect(first).toEqual(second);
    expect(preferences.updateSettings).toHaveBeenCalledTimes(1);
  });

  it('replays an unfinished annotation mutation before processing new work', async () => {
    const pending: TraderAnnotationUpdate = { label: 'Momentum' };
    const records: Record<string, unknown> = {
      'preference-mutation-journal.v1': {
        version: 1,
        pending: {
          mutationId: 'note-1',
          type: 'annotation-upsert',
          traderId: 'trader-1',
          update: pending,
          at: 1_800_000_000_000,
        },
        receipts: [],
      },
    };
    const annotation: TraderAnnotationV1 = {
      traderId: 'trader-1', label: 'Momentum', updatedAt: 1_800_000_000_000,
    };
    const preferences: PreferenceMutationPreferences = {
      updateSettings: vi.fn(),
      upsertAnnotation: vi.fn(async () => annotation),
      deleteAnnotation: vi.fn(),
    };
    const coordinator = new PreferenceMutationCoordinator({
      preferences,
      storage: {
        get: async (keys) => Object.fromEntries(keys
          .filter((key) => key in records)
          .map((key) => [key, records[key]])),
        set: async (items) => { Object.assign(records, items); },
      },
    });

    await coordinator.ready();

    expect(preferences.upsertAnnotation).toHaveBeenCalledWith(
      'trader-1', pending, 1_800_000_000_000,
    );
  });
});
