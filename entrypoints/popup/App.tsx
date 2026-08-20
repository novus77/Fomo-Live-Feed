import { useMemo } from 'react';

import { PopupApp, type PopupDependencies } from '../../src/popup/PopupApp';
import type { PopupRuntimeLike, PopupStorageLike } from '../../src/popup/popup-io';

import './popup.css';

/**
 * Thin WXT popup composition root (plan Task 9/10 deliverable note): every
 * browser API is injected here and all logic lives in src/popup/* so the
 * popup is unit-testable without a real Chrome runtime.
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
      copyText: (text: string) => navigator.clipboard.writeText(text),
    };
  }, []);

  return <PopupApp deps={deps} />;
}
