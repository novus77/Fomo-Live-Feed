import { installFomoBridge } from '../src/fomo/bridge';
import { installContentTranslationHost } from '../src/translation/content-translation-host';

export default defineContentScript({
  matches: ['https://fomo.family/*', 'https://www.fomo.family/*'],
  runAt: 'document_start',
  main() {
    installFomoBridge({
      window,
      sendMessage: (message) => {
        void browser.runtime.sendMessage(message).catch(() => {});
      },
    });
    installContentTranslationHost(browser.runtime);
  },
});
