import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Fomo Live Feed',
    description:
      'Surface real-time trader activity from followed Fomo users while browsing supported trading platforms.',
    action: {},
    // Task 7 Step 7: the on-device translation API (Translator /
    // LanguageDetector) ships in Chrome 138, so the extension no longer
    // installs on older builds.
    minimum_chrome_version: '138',
    permissions: ['storage', 'sidePanel'],
    host_permissions: [
      'https://fomo.family/*',
      'https://www.fomo.family/*',
      'https://dexscreener.com/*',
      'https://gmgn.ai/*',
    ],
  },
});
