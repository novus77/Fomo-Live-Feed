import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Fomo Live Feed',
    description:
      'Show real-time activity from followed Fomo traders in Chrome Side Panel.',
    icons: {
      16: 'icons/icon-16.png',
      32: 'icons/icon-32.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
    // Atomic Side Panel -> floating-window handoff uses sidePanel.close(),
    // which is available from Chrome 141.
    minimum_chrome_version: '141',
    permissions: ['storage', 'sidePanel', 'offscreen'],
    host_permissions: [
      'https://fomo.family/*',
      'https://www.fomo.family/*',
    ],
  },
});
