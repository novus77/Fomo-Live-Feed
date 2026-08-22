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
    // Task 7 Step 7: the on-device translation API (Translator /
    // LanguageDetector) ships in Chrome 138, so the extension no longer
    // installs on older builds.
    minimum_chrome_version: '138',
    permissions: ['storage', 'sidePanel'],
    host_permissions: [
      'https://fomo.family/*',
      'https://www.fomo.family/*',
      'https://translate.googleapis.com/*',
    ],
  },
});
