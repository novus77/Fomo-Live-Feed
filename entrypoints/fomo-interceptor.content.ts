import { installFomoWebSocketObserver } from '../src/fomo/websocket-observer';

export default defineContentScript({
  matches: ['https://fomo.family/*', 'https://www.fomo.family/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installFomoWebSocketObserver(window, () => Date.now());
  },
});
