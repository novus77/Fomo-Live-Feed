import { installPumpBridge } from '../src/pump/bridge';

export default defineContentScript({
  matches: ['https://pump.fun/*', 'https://www.pump.fun/*'],
  runAt: 'document_start',
  main() {
    installPumpBridge({
      window,
      sendMessage: (message) => browser.runtime.sendMessage(message),
    });
  },
});
