import { installPumpPageCollector } from '../src/pump/page-collector';

export default defineContentScript({
  matches: ['https://pump.fun/*', 'https://www.pump.fun/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installPumpPageCollector(window);
  },
});
