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
      document,
      sendMessage: (message) => {
        void browser.runtime.sendMessage(message).catch(() => {});
      },
    });
    installFomoDomActivityObserver({
      document,
      initialDelayMs: 1_500,
      // Authentication is sticky, capture freshness is not. Recovery may
      // overlap primary capture; stable trade aliases deduplicate the rows.
      isFallbackEnabled: () => bridge.shouldUseDomFallback(),
      onLiveActivity: (activity) => bridge.noteDomActivity(activity),
      emit: async (activity) => {
        try {
          const response: unknown = await browser.runtime.sendMessage({
            protocolVersion: PROTOCOL_VERSION,
            type: 'activity.ingest',
            payload: activity,
          });
          return typeof response === 'object' && response !== null &&
            'ok' in response && response.ok === true;
        } catch {
          return false;
        }
      },
    });
    installContentTranslationHost(browser.runtime);
    browser.runtime.onMessage.addListener((message: unknown) => {
      const parsed = parseExtensionMessage(message);
      if (parsed.ok && parsed.message.type === 'capture.ping') {
        bridge.reportConnection();
        return Promise.resolve({ ok: true as const });
      }
      return undefined;
    });
  },
});
