import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, type LocalSettingsUpdate, type LocalSettingsV5 } from '../../src/domain/settings';
import {
  LocaleProvider,
  useLocale,
  type LocalePreferencesLike,
  type LocaleStorageChangesLike,
} from '../../src/i18n/LocaleProvider';
import { SETTINGS_STORAGE_KEY } from '../../src/storage/local-preferences';

const createFakePreferences = (
  options: {
    initialSettings?: LocalSettingsV5 | undefined;
    failReads?: boolean;
  } = {},
): {
  preferences: LocalePreferencesLike;
  updateCalls: LocalSettingsUpdate[];
  getStored: () => LocalSettingsV5;
  readCount: () => number;
} => {
  let stored: LocalSettingsV5 = options.initialSettings ?? { ...DEFAULT_SETTINGS, uiLocale: 'en' };
  const updateCalls: LocalSettingsUpdate[] = [];
  let reads = 0;

  return {
    preferences: {
      async getSettings(): Promise<LocalSettingsV5> {
        reads += 1;

        if (options.failReads === true) {
          throw new Error('storage read failed');
        }

        return stored;
      },
      async updateSettings(update: LocalSettingsUpdate): Promise<LocalSettingsV5> {
        updateCalls.push(update);
        stored = {
          ...stored,
          notifications: { ...stored.notifications, ...(update.notifications ?? {}) },
          filters: { ...stored.filters, ...(update.filters ?? {}) },
          opinionTranslation: {
            ...stored.opinionTranslation,
            ...(update.opinionTranslation ?? {}),
          },
          ...(update.uiLocale !== undefined ? { uiLocale: update.uiLocale } : {}),
        };

        return stored;
      },
    },
    updateCalls,
    getStored: () => stored,
    readCount: () => reads,
  };
};

const createFakeOnChanged = (): {
  onChanged: LocaleStorageChangesLike;
  emit(changes: Record<string, unknown>, areaName?: string): void;
} => {
  const listeners: Array<
    (changes: Record<string, unknown>, areaName: string) => void
  > = [];

  return {
    onChanged: {
      addListener(listener) {
        listeners.push(listener);
      },
      removeListener(listener) {
        const index = listeners.indexOf(listener);

        if (index >= 0) {
          listeners.splice(index, 1);
        }
      },
    },
    emit(changes, areaName = 'local') {
      for (const listener of [...listeners]) {
        listener(changes, areaName);
      }
    },
  };
};

function Probe() {
  const { locale, setLocale, translate } = useLocale();

  return (
    <div>
      <span data-testid="locale">{locale}</span>
      <span data-testid="title">{translate('header.title')}</span>
      <button onClick={() => setLocale('zh-CN')}>switch-zh</button>
      <button onClick={() => setLocale('en')}>switch-en</button>
    </div>
  );
}

const renderProvider = (
  preferences: LocalePreferencesLike,
  extra: Partial<Parameters<typeof LocaleProvider>[0]> = {},
) =>
  render(
    <LocaleProvider preferences={preferences} {...extra}>
      <Probe />
    </LocaleProvider>,
  );

describe('LocaleProvider', () => {
  it('resolves the first-run locale from the stored settings (browser-derived)', async () => {
    const { preferences } = createFakePreferences({
      initialSettings: { ...DEFAULT_SETTINGS, uiLocale: 'zh-CN' },
    });

    renderProvider(preferences);

    expect(await screen.findByTestId('locale')).toHaveTextContent('zh-CN');
    expect(screen.getByTestId('title')).toHaveTextContent('Fomo 实时动态');
  });

  it('uses a stored override instead of the browser locale', async () => {
    const { preferences } = createFakePreferences({
      initialSettings: { ...DEFAULT_SETTINGS, uiLocale: 'zh-CN' },
    });

    renderProvider(preferences);

    expect(await screen.findByTestId('locale')).toHaveTextContent('zh-CN');
  });

  it('switches locale immediately without a reload or another read', async () => {
    const { preferences, readCount } = createFakePreferences();

    renderProvider(preferences);

    expect(await screen.findByTestId('locale')).toHaveTextContent('en');
    expect(screen.getByTestId('title')).toHaveTextContent('Fomo Live Feed');

    const readsBeforeSwitch = readCount();

    fireEvent.click(screen.getByText('switch-zh'));

    expect(screen.getByTestId('locale')).toHaveTextContent('zh-CN');
    expect(screen.getByTestId('title')).toHaveTextContent('Fomo 实时动态');
    expect(readCount()).toBe(readsBeforeSwitch);
  });

  it('persists the switch through updateSettings so it survives a restart', async () => {
    const first = createFakePreferences();

    renderProvider(first.preferences);
    fireEvent.click(await screen.findByText('switch-zh'));

    expect(first.updateCalls).toEqual([{ uiLocale: 'zh-CN' }]);
    expect(first.getStored()).toMatchObject({ uiLocale: 'zh-CN' });

    // A fresh provider reading the persisted value starts in Chinese.
    const second = createFakePreferences({
      initialSettings: first.getStored(),
    });

    renderProvider(second.preferences);

    expect(await screen.findByTestId('locale')).toHaveTextContent('zh-CN');
  });

  it('propagates locale changes written from another context via storage.onChanged', async () => {
    const { preferences, getStored } = createFakePreferences();
    const { onChanged, emit } = createFakeOnChanged();

    renderProvider(preferences, { onChanged });

    expect(await screen.findByTestId('locale')).toHaveTextContent('en');

    // Another context (popup/overlay) switched to zh-CN in storage.
    await preferences.updateSettings({ uiLocale: 'zh-CN' });
    emit({ [SETTINGS_STORAGE_KEY]: getStored() });

    await waitFor(() => {
      expect(screen.getByTestId('locale')).toHaveTextContent('zh-CN');
    });
    expect(screen.getByTestId('title')).toHaveTextContent('Fomo 实时动态');
  });

  it('ignores storage changes for unrelated keys and non-local areas', async () => {
    const { preferences } = createFakePreferences();
    const { onChanged, emit } = createFakeOnChanged();

    renderProvider(preferences, { onChanged });
    await screen.findByTestId('locale');

    emit({ 'other.key': { value: 1 } });
    emit({ [SETTINGS_STORAGE_KEY]: { value: 1 } }, 'sync');

    // No re-read was triggered for unrelated changes.
    expect(screen.getByTestId('locale')).toHaveTextContent('en');
  });

  it('is independent from the opinionTranslation preference', async () => {
    const { preferences, updateCalls } = createFakePreferences({
      initialSettings: {
        ...DEFAULT_SETTINGS,
        uiLocale: 'en',
        opinionTranslation: { enabled: true, targetLanguage: 'zh' },
      },
    });

    renderProvider(preferences);

    // UI locale stays en even though the translation target is zh.
    expect(await screen.findByTestId('locale')).toHaveTextContent('en');

    fireEvent.click(screen.getByText('switch-zh'));

    // The switch touches ONLY uiLocale - never opinionTranslation.
    expect(updateCalls).toEqual([{ uiLocale: 'zh-CN' }]);
  });

  it('falls back to the browser/fallback locale when the settings read fails', async () => {
    const { preferences } = createFakePreferences({ failReads: true });

    renderProvider(preferences, { fallbackLocale: 'zh-CN' });

    expect(await screen.findByTestId('locale')).toHaveTextContent('zh-CN');
  });

  it('throws a helpful error when useLocale is used without a provider', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => render(<Probe />)).toThrow(
      'useLocale must be used inside a LocaleProvider',
    );

    spy.mockRestore();
  });
});
