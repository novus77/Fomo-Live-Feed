import {
  installFomoActivityFetchObserver,
  installFomoActivityXhrObserver,
  installFomoBridgeReplay,
  installFomoWebSocketListenerObserver,
} from '../src/fomo/websocket-observer';

export default defineContentScript({
  matches: ['https://fomo.family/*', 'https://www.fomo.family/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installFomoBridgeReplay(window);
    // Preserve the native constructor so the page does not switch to an
    // unobserved iframe realm when it detects constructor replacement.
    installFomoWebSocketListenerObserver(window, () => Date.now());
    installFomoActivityFetchObserver(window);
    installFomoActivityXhrObserver(window);
  },
});
