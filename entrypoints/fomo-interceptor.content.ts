import {
  installFomoActivityFetchObserver,
  installFomoActivityXhrObserver,
  installFomoBridgeReplay,
  installFomoWebSocketObserver,
} from '../src/fomo/websocket-observer';

export default defineContentScript({
  matches: ['https://fomo.family/*', 'https://www.fomo.family/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installFomoBridgeReplay(window);
    installFomoWebSocketObserver(window, () => Date.now());
    installFomoActivityFetchObserver(window);
    installFomoActivityXhrObserver(window);
  },
});
