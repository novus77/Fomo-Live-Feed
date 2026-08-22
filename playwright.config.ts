import { defineConfig } from '@playwright/test';

/**
 * E2E configuration (plan Task 12).
 *
 * The suite lives in tests/e2e and launches its OWN Chromium instance with
 * the production extension (.output/chrome-mv3) loaded unpacked, plus the
 * HTTPS CONNECT-proxy fixture server (see tests/e2e/fixture-server.ts and
 * live-feed.spec.ts). The extension must be built first (pnpm build).
 *
 * The launch is headless by default (headless Chromium supports MV3
 * extensions with channel: 'chromium'); set FOMO_E2E_HEADED=1 for a visible
 * browser window when debugging locally. workers is pinned to 1 because the
 * suite owns a single shared browser context and fixture server.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  workers: 1,
  fullyParallel: false,
  use: {
    headless: true,
  },
});
