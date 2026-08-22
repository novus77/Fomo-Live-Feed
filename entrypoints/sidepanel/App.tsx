import { useMemo } from 'react';

import {
  SidePanelApp,
  type SidePanelDependencies,
} from '../../src/sidepanel/SidePanelApp';
import type { PopupRuntimeLike, PopupStorageLike } from '../../src/popup/popup-io';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import { LocalPreferences } from '../../src/storage/local-preferences';
import {
  isUnsupportedSidePanelUrl,
  UnsupportedSidePanel,
} from '../../src/sidepanel/UnsupportedSidePanel';

import './sidepanel.css';

/**
 * Thin WXT side panel composition root: every
 * browser API is injected here and the side-panel composition stays
 * unit-testable without a real Chrome runtime.
 *
 * A single `LocalPreferences` instance is created here (once) and shared by
 * the LocaleProvider wrapper AND the SidePanelApp deps, so the panel never
 * constructs a second settings surface. The LocaleProvider owns the UI
 * locale (resolve, persist, cross-context propagation via
 * chrome.storage.onChanged) for every surface this root renders, including
 * the unsupported fallback page.
 */
export function App() {
  const unsupported = isUnsupportedSidePanelUrl(window.location.href);
  const deps = useMemo<SidePanelDependencies>(() => {
    const runtime: PopupRuntimeLike = {
      sendMessage: (message: unknown) => browser.runtime.sendMessage(message),
      onMessage: browser.runtime.onMessage,
    };

    const storage: PopupStorageLike = {
      local: browser.storage.local,
      onChanged: browser.storage.onChanged,
    };

    return {
      runtime,
      storage,
      now: () => Date.now(),
      openLink: (url: URL) => {
        window.open(url.href, '_blank', 'noopener,noreferrer');
      },
      copyText: (text: string) => navigator.clipboard.writeText(text),
    };
  }, []);

  // One settings surface for the whole side panel (locale + annotations +
  // opinion-translation preferences): memoized so LocaleProvider and
  // SidePanelApp share the exact same instance.
  const preferences = useMemo(
    () => new LocalPreferences(browser.storage.local),
    [],
  );

  return (
    <LocaleProvider
      preferences={preferences}
      onChanged={browser.storage.onChanged}
    >
      {unsupported ? (
        <UnsupportedSidePanel />
      ) : (
        <SidePanelApp deps={{ ...deps, preferences }} />
      )}
    </LocaleProvider>
  );
}
