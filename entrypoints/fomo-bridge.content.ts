import { installFomoBridge } from '../src/fomo/bridge';

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
  },
});
