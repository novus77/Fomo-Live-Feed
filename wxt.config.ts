import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Fomo Live Feed',
    description:
      'Surface real-time trader activity from followed Fomo users while browsing supported trading platforms.',
    action: {},
    minimum_chrome_version: '114',
    permissions: ['storage', 'sidePanel'],
    host_permissions: [
      'https://fomo.family/*',
      'https://www.fomo.family/*',
      'https://dexscreener.com/*',
      'https://gmgn.ai/*',
    ],
  },
});
