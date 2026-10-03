import { useEffect, useMemo, useState } from 'react';

import { DEFAULT_SETTINGS, type UiTheme } from '../domain/settings';
import type { SidePanelDependencies } from '../sidepanel/SidePanelApp';
import {
  LocalPreferences,
  SETTINGS_STORAGE_KEY,
} from '../storage/local-preferences';

/** Resolves the shared UI theme for chrome rendered outside SidePanelApp. */
export function useSurfaceTheme(deps: SidePanelDependencies): UiTheme {
  const preferences = useMemo(
    () => deps.preferences ?? new LocalPreferences(deps.storage.local),
    [deps.preferences, deps.storage.local],
  );
  const [theme, setTheme] = useState<UiTheme>(DEFAULT_SETTINGS.uiTheme);

  useEffect(() => {
    let disposed = false;
    let latestRequest = 0;
    const reload = (): void => {
      const request = ++latestRequest;
      void preferences.getSettings().then((settings) => {
        if (!disposed && request === latestRequest) setTheme(settings.uiTheme);
      }).catch(() => {});
    };
    const onStorageChanged = (
      changes: Record<string, unknown>,
      areaName: string,
    ): void => {
      if (areaName === 'local' && changes[SETTINGS_STORAGE_KEY] !== undefined) {
        reload();
      }
    };

    reload();
    deps.storage.onChanged.addListener(onStorageChanged);
    return () => {
      disposed = true;
      deps.storage.onChanged.removeListener(onStorageChanged);
    };
  }, [deps.storage.onChanged, preferences]);

  return theme;
}
