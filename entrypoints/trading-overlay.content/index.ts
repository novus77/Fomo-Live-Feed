import {
  installTradingOverlay,
  OVERLAY_MATCHES,
} from '../../src/overlay/trading-overlay';

import styleText from './style.css?inline';

/**
 * Thin WXT entrypoint for the supported-site overlay: all behavior lives in
 * src/overlay/trading-overlay.ts (mirroring how fomo-bridge.content.ts
 * delegates to src/fomo/bridge.ts), so the real listener is integration
 * tested without a Chrome runtime.
 */
export default defineContentScript({
  matches: [...OVERLAY_MATCHES],
  runAt: 'document_idle',
  main() {
    const cleanup = installTradingOverlay({
      document,
      now: () => Date.now(),
      styleText,
      runtime: {
        onMessage: browser.runtime.onMessage,
      },
      storage: {
        local: browser.storage.local,
        onChanged: browser.storage.onChanged,
      },
      clipboard: navigator.clipboard,
    });

    window.addEventListener('pagehide', cleanup, { once: true });
  },
});