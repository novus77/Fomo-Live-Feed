import { useMemo } from 'react';

import {
  SidePanelApp,
  type SidePanelDependencies,
} from '../../src/sidepanel/SidePanelApp';
import type { PopupRuntimeLike, PopupStorageLike } from '../../src/popup/popup-io';

import './sidepanel.css';

/**
 * Thin WXT side panel composition root: every
 * browser API is injected here and the side-panel composition stays
 * unit-testable without a real Chrome runtime.
 */
export function App() {
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

  return <SidePanelApp deps={deps} />;
}
