import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

import type { LocalSettingsUpdate, LocalSettingsV6 } from '../domain/settings';
import {
  LEGACY_SETTINGS_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
} from '../storage/local-preferences';
import {
  resolveBrowserLocale,
  translate as translateMessage,
  type MessageKey,
  type UiLocale,
} from './catalog';

/**
 * Locale context (plan Task 6 Step 3, spec section 10).
 *
 * LocaleProvider owns ONLY locale resolution, persistence, and message
 * lookup. It never touches `opinionTranslation` - that preference is
 * independent of the UI locale (spec 9.2) and is owned by the translation
 * services in plan Task 7.
 *
 * - The initial locale is the stored `settings.v2.uiLocale` (which the
 *   storage layer already initializes from the browser locale on first
 *   run / V1 migration); a failed read falls back to the browser locale.
 * - `setLocale` updates the context immediately (no reload) and persists
 *   through `updateSettings({ uiLocale })`.
 * - When `onChanged` (chrome.storage.onChanged) is provided, a settings
 *   change from another context (popup, overlay) re-reads the stored locale
 *   so every surface stays in sync.
 */

export interface LocalePreferencesLike {
  getSettings(): Promise<LocalSettingsV6>;
  updateSettings(update: LocalSettingsUpdate): Promise<LocalSettingsV6>;
}

export interface LocaleStorageChangesLike {
  addListener(
    listener: (changes: Record<string, unknown>, areaName: string) => void,
  ): void;
  removeListener(
    listener: (changes: Record<string, unknown>, areaName: string) => void,
  ): void;
}

export interface LocaleProviderProps {
  children: ReactNode;
  /** Settings surface used to read and persist the UI locale. */
  preferences: LocalePreferencesLike;
  /** Optional privileged writer used by multi-surface extension UIs. */
  mutateSettings?: (update: LocalSettingsUpdate) => Promise<LocalSettingsV6>;
  /** chrome.storage.onChanged surface for cross-context propagation. */
  onChanged?: LocaleStorageChangesLike;
  /** Fallback when the preferences read fails; defaults to the browser locale. */
  fallbackLocale?: UiLocale;
}

export interface LocaleContextValue {
  locale: UiLocale;
  setLocale(locale: UiLocale): void;
  translate(
    key: MessageKey,
    values?: Readonly<Record<string, string | number>>,
  ): string;
}

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider(props: LocaleProviderProps) {
  const { children, preferences, mutateSettings, onChanged, fallbackLocale } = props;
  const [locale, setLocale] = useState<UiLocale | null>(null);

  useEffect(() => {
    let disposed = false;

    const reload = async (): Promise<void> => {
      let next: UiLocale;

      try {
        next = (await preferences.getSettings()).uiLocale;
      } catch {
        next = fallbackLocale ?? resolveBrowserLocale();
      }

      if (!disposed) {
        setLocale(next);
      }
    };

    void reload();

    if (onChanged !== undefined) {
      const listener = (
        changes: Record<string, unknown>,
        areaName: string,
      ): void => {
        if (areaName !== 'local') {
          return;
        }

        if (
          changes[SETTINGS_STORAGE_KEY] === undefined &&
          changes[LEGACY_SETTINGS_STORAGE_KEY] === undefined
        ) {
          return;
        }

        void reload();
      };

      onChanged.addListener(listener);

      return () => {
        disposed = true;
        onChanged.removeListener(listener);
      };
    }

    return () => {
      disposed = true;
    };
  }, [preferences, onChanged, fallbackLocale]);

  const setLocaleAndPersist = useCallback(
    (next: UiLocale): void => {
      // Update the context first so the EN / 中文 switch is immediate; the
      // write is fire-and-forget and any failure keeps the in-memory choice.
      setLocale(next);
      void (mutateSettings ?? preferences.updateSettings.bind(preferences))({ uiLocale: next })
        .catch(() => {});
    },
    [preferences, mutateSettings],
  );

  // All hooks above run on every render; children render only once the
  // locale is known so the first paint never flashes the wrong language.
  const value = useMemo<LocaleContextValue | null>(() => {
    if (locale === null) {
      return null;
    }

    return {
      locale,
      setLocale: setLocaleAndPersist,
      translate: (key, values) => translateMessage(locale, key, values),
    };
  }, [locale, setLocaleAndPersist]);

  if (value === null) {
    return null;
  }

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale(): LocaleContextValue {
  const value = useContext(LocaleContext);

  if (value === null) {
    throw new Error('useLocale must be used inside a LocaleProvider');
  }

  return value;
}
