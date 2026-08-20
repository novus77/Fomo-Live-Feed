import { useMemo } from 'react';

import { PopupApp, type PopupDependencies } from '../../src/popup/PopupApp';
import type { PopupRuntimeLike, PopupStorageLike } from '../../src/popup/popup-io';

import './sidepanel.css';

/**
 * Thin WXT side panel composition root: every
 * browser API is injected here and all logic lives in src/popup/* so the
 * view is unit-testable without a real Chrome runtime.
 */
export function App() {
  const deps = useMemo<PopupDependencies>(() => {
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

  return <PopupApp deps={deps} />;
}
