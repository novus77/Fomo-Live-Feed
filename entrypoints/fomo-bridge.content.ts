import { installFomoBridge } from '../src/fomo/bridge';
import { installFomoDomActivityObserver } from '../src/fomo/dom-activity-observer';
import { installContentTranslationHost } from '../src/translation/content-translation-host';
import {
  parseExtensionMessage,
  PROTOCOL_VERSION,
} from '../src/messaging/protocol';

export default defineContentScript({
  matches: ['https://fomo.family/*', 'https://www.fomo.family/*'],
  runAt: 'document_start',
  main() {
    const bridge = installFomoBridge({
      window,
      sendMessage: (message) => {
        void browser.runtime.sendMessage(message).catch(() => {});
      },
    });
    installFomoDomActivityObserver({
      document,
      initialDelayMs: 1_500,
      // The DOM is only a recovery path. Once the authenticated interceptor
      // is live, observing rendered cards would mirror the same trade twice.
      isFallbackEnabled: () => !bridge.hasAuthenticatedCapture(),
      emit: async (activity) => {
        try {
          await browser.runtime.sendMessage({
            protocolVersion: PROTOCOL_VERSION,
            type: 'activity.ingest',
            payload: activity,
          });
          return true;
        } catch {
          return false;
        }
      },
    });
    installContentTranslationHost(browser.runtime);
    browser.runtime.onMessage.addListener((message: unknown) => {
      const parsed = parseExtensionMessage(message);
      if (parsed.ok && parsed.message.type === 'capture.ping') {
        return Promise.resolve({ ok: true as const });
      }
      return undefined;
    });
  },
});
