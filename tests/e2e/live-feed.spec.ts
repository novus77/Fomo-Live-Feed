import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Worker,
} from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startFixtureServer, type FixtureServer } from './fixture-server';

/**
 * Extension E2E suite (plan Task 12 Step 2, spec sections 7.1, 10, 12).
 *
 * Launches real Chromium with the production build (.output/chrome-mv3)
 * loaded as an unpacked MV3 extension, serves the deterministic fixtures over
 * the HTTPS CONNECT-proxy fixture server (see fixture-server.ts), and drives
 * the full chain: fixture WebSocket frame -> MAIN-world interceptor ->
 * isolated bridge -> service worker ingest -> persistent Side Panel history.
 *
 * Playwright does not expose Chrome's Side Panel as a normal Page. The
 *    suite therefore opens the REAL panel through chrome.sidePanel.open()
 *    and drives its extension target through a CDP-attached session.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(here, 'fixtures');
const EXTENSION_DIR = path.resolve(here, '../../.output/chrome-mv3');
const EXPECTED_EXPLICIT_HOSTS = [
  'https://fomo.family/*',
  'https://www.fomo.family/*',
  'https://translate.googleapis.com/*',
];

// Set FOMO_E2E_HEADED=1 to run with a visible browser window (local
// debugging); CI and the default keep headless.
const HEADED = process.env.FOMO_E2E_HEADED === '1';

interface ActivityPayload {
  id: string;
  tradeId?: string;
  type: 'swap_buy' | 'swap_sell' | 'swap_withdraw' | 'transfer_out' | 'thesis';
  userId: string;
  userHandle: string;
  displayName?: string;
  ticker: string;
  tokenAddress: string;
  networkId: number;
  usdAmount?: number;
  marketCap?: number;
  price?: number;
  createdAt: string;
  /** Thesis prose (type: 'thesis'); normalized to TradeEventV1.thesis. */
  comment?: string;
}

/** A valid raw Fomo trading_activity payload (src/fomo/raw-schema.ts). */
const robinhoodBuy: ActivityPayload = {
  id: 'activity-1',
  tradeId: 'trade-1',
  type: 'swap_buy',
  userId: 'trader-1',
  userHandle: 'robinhood',
  displayName: 'Robin Hood',
  ticker: 'ROBINHOOD',
  tokenAddress: '0x020bfc650a365f8bb26819deaabf3e21291018b4',
  networkId: 56,
  usdAmount: 1250.5,
  marketCap: 4_200_000,
  price: 0.42,
  createdAt: '2026-08-20T08:15:30.000Z',
};

const uniquePayload = (index: number): ActivityPayload => ({
  ...robinhoodBuy,
  id: 'overflow-' + index,
  tradeId: 'overflow-trade-' + index,
  ticker: 'TOKEN' + index,
  tokenAddress: '0x' + index.toString(16).padStart(40, '0'),
  createdAt: '2026-08-20T08:15:3' + (index % 10) + '.000Z',
});

/** An English-thesis activity that the on-device double translates to zh. */
const thesisPayload = (index: number): ActivityPayload => ({
  ...robinhoodBuy,
  id: 'thesis-' + index,
  tradeId: 'thesis-trade-' + index,
  type: 'thesis',
  comment: 'Rotation into L1s ' + index,
  ticker: 'THESIS' + index,
  tokenAddress: '0x' + (0x1000 + index).toString(16).padStart(40, '0'),
  createdAt: '2026-08-21T09:0' + index + ':00.000Z',
});

/** The fixed Chinese translation the E2E translation double returns. */
const TRANSLATED_THESIS = '轮动进入 L1 板块';

// ---------------------------------------------------------------------------
// Settings seeding through the worker's chrome.storage.local
// ---------------------------------------------------------------------------

/**
 * The settings.v4 record shape the E2E suite seeds/reads through the worker.
 * Mirrors src/domain/settings.ts localSettingsV4Schema. Tests share one
 * extension profile, so every test that depends on a specific locale or
 * translation preference seeds it explicitly before opening the panel.
 */
interface StoredSettingsV4 {
  schemaVersion: 4;
  notifications: {
    enabled: boolean;
    maxVisibleToasts: number;
    durationMs: number;
    soundEnabled: boolean;
  };
  filters: { mutedChains: string[] };
  uiLocale: string;
  uiTheme: 'light' | 'dark';
  opinionTranslation: { enabled: boolean; targetLanguage: string };
}

const DEFAULT_STORED_SETTINGS: StoredSettingsV4 = {
  schemaVersion: 4,
  notifications: { enabled: true, maxVisibleToasts: 3, durationMs: 8000, soundEnabled: false },
  filters: { mutedChains: [] },
  uiLocale: 'en',
  uiTheme: 'dark',
  opinionTranslation: { enabled: true, targetLanguage: 'auto' },
};

/** Rewrites settings.v4 through the worker's chrome.storage.local. */
const seedStoredSettings = (patch: Partial<StoredSettingsV4>): Promise<void> =>
  worker!.evaluate(async (record) => {
    const chromeApi = (globalThis as unknown as {
      chrome: { storage: { local: { set(item: Record<string, unknown>): Promise<void> } } };
    }).chrome;
    await chromeApi.storage.local.set({ 'settings.v4': record });
  }, { ...DEFAULT_STORED_SETTINGS, ...patch });

/** Reads the current settings.v4 record through the worker. */
const readStoredSettings = (): Promise<StoredSettingsV4> =>
  worker!.evaluate(async () => {
    const chromeApi = (globalThis as unknown as {
      chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
    }).chrome;
    const stored = await chromeApi.storage.local.get('settings.v4');
    return stored['settings.v4'] as StoredSettingsV4;
  });

/** Id of the active Fomo tab, falling back to the first open fixture tab. */
const fomoTabId = (): Promise<number> =>
  worker!.evaluate(async () => {
    const chromeApi = (globalThis as unknown as {
      chrome: { tabs: { query(options: { url: string; active?: boolean }): Promise<Array<{ id?: number }>> } };
    }).chrome;
    const activeTabs = await chromeApi.tabs.query({ url: 'https://fomo.family/*', active: true });
    const tabs = activeTabs.length > 0
      ? activeTabs
      : await chromeApi.tabs.query({ url: 'https://fomo.family/*' });
    if (tabs[0]?.id === undefined) throw new Error('Fomo fixture tab is unavailable');
    return tabs[0].id;
  });

let server: FixtureServer | null = null;
let context: BrowserContext | null = null;
let worker: Worker | null = null;
let userDataDir: string | null = null;
let extensionId: string | null = null;

test.beforeAll(async () => {
  server = await startFixtureServer(FIXTURES_DIR);
  userDataDir = mkdtempSync(path.join(os.tmpdir(), 'fomo-e2e-profile-'));

  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: !HEADED,
    locale: 'en-US',
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      `--proxy-server=127.0.0.1:${server.port}`,
      '--disable-quic',
      '--ignore-certificate-errors',
    ],
  });

  let registered: Worker | undefined = context.serviceWorkers()[0];

  for (let attempt = 0; attempt < 30 && registered === undefined; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    registered = context.serviceWorkers()[0];
  }

  if (registered === undefined) {
    throw new Error('the extension service worker did not start');
  }

  worker = registered;
  extensionId = new URL(worker.url()).host;

  // Force the extension UI to English for deterministic E2E assertions.
  // The real browser locale may be non-English; LocaleProvider reads uiLocale
  // from chrome.storage.local, so seed a valid V3 settings record.
  await worker.evaluate(async () => {
    const chromeApi = (globalThis as unknown as {
      chrome: { storage: { local: { set(item: Record<string, unknown>): Promise<void> } } };
    }).chrome;
    await chromeApi.storage.local.set({
      'settings.v4': {
        schemaVersion: 4,
        notifications: { enabled: true, maxVisibleToasts: 3, durationMs: 8000, soundEnabled: false },
        filters: { mutedChains: [] },
        uiLocale: 'en',
        uiTheme: 'dark',
        opinionTranslation: { enabled: true, targetLanguage: 'auto' },
      },
    });
  });
});

test.afterAll(async () => {
  await context?.close();

  if (userDataDir !== null) {
    rmSync(userDataDir, { recursive: true, force: true });
  }

  await server?.close();
});

const fomoUrl = (): string => 'https://fomo.family/fomo-page.html';
const tradingUrl = (): string => 'https://dexscreener.com/trading-page.html';

/** Emits one trading_activity frame through the fixture's WebSocket source. */
const emit = (page: Page, payload: ActivityPayload): Promise<void> =>
  page.evaluate((value) => {
    (window as unknown as { __fomoEmitActivity(payload: unknown): void }).__fomoEmitActivity(
      value,
    );
  }, payload);

const markSocketClosed = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as unknown as { __fomoMarkSocketClosed(): void }).__fomoMarkSocketClosed();
  });

const markSocketOpen = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as unknown as { __fomoMarkSocketOpen(): void }).__fomoMarkSocketOpen();
  });

// ---------------------------------------------------------------------------
// CDP-attached driver for the REAL extension Side Panel
// ---------------------------------------------------------------------------

/** Minimal client for a CDP session attached via Target.attachToTarget. */
class AttachedTarget {
  private readonly pending = new Map<number, (message: Record<string, unknown>) => void>();
  private nextId = 1;
  private disposed = false;
  private readonly onMessage: (event: unknown) => void;

  constructor(
    private readonly cdp: CDPSession,
    private readonly sessionId: string,
  ) {
    this.onMessage = (event: unknown): void => {
      const record = event as { message?: unknown };

      if (typeof record.message !== 'string') {
        return;
      }

      let parsed: unknown;

      try {
        parsed = JSON.parse(record.message) as unknown;
      } catch {
        return;
      }

      if (typeof parsed !== 'object' || parsed === null) {
        return;
      }

      const message = parsed as { id?: unknown };

      if (typeof message.id !== 'number') {
        return;
      }

      const resolve = this.pending.get(message.id);

      if (resolve !== undefined) {
        this.pending.delete(message.id);
        resolve(parsed as Record<string, unknown>);
      }
    };

    this.cdp.on('Target.receivedMessageFromTarget', this.onMessage);
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId;
    this.nextId += 1;

    const response = new Promise<Record<string, unknown>>((resolve) => {
      this.pending.set(id, resolve);
    });

    await this.cdp.send('Target.sendMessageToTarget', {
      sessionId: this.sessionId,
      message: JSON.stringify({ id, method, params }),
    });

    return response;
  }

  /** Runtime.evaluate with returnByValue; undefined on error or non-value. */
  async evaluate<T>(expression: string): Promise<T | undefined> {
    const response = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
    });

    const remote = response.result as { result?: { value?: T } } | undefined;

    if (remote === undefined || typeof remote !== 'object') {
      return undefined;
    }

    const inner = remote.result;

    if (inner === undefined || typeof inner !== 'object') {
      return undefined;
    }

    return (inner as { value?: T }).value;
  }

  /** True when the Side Panel's rendered body contains the given text. */
  async hasText(text: string): Promise<boolean> {
    const body = await this.evaluate<string>('document.body ? document.body.innerText : ""');

    return body !== undefined && body.includes(text);
  }

  /** Number of rendered history rows (.event-card). */
  async cardCount(): Promise<number> {
    const count = await this.evaluate<number>("document.querySelectorAll('.event-card').length");

    return count ?? 0;
  }

  /** True when at least one element matches the selector. */
  async exists(selector: string): Promise<boolean> {
    const count = await this.evaluate<number>(`document.querySelectorAll(${JSON.stringify(selector)}).length`);

    return (count ?? 0) > 0;
  }

  /** True once the Side Panel finished loading and rendered the feed area. */
  async feedRendered(): Promise<boolean> {
    const count = await this.evaluate<number>("document.querySelectorAll('.popup-feed').length");

    return (count ?? 0) > 0;
  }

  async click(selector: string): Promise<void> {
    await this.assertAction(
      `(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) return false; element.click(); return true; })()`,
      `click ${selector}`,
    );
  }

  async setInput(selector: string, value: string): Promise<void> {
    await this.assertAction(
      `(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!(input instanceof HTMLInputElement)) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; if (setter === undefined) return false; setter.call(input, ${JSON.stringify(value)}); return input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      `set input ${selector}`,
    );
  }

  async selectOption(selector: string, value: string): Promise<void> {
    await this.assertAction(
      `(() => { const select = document.querySelector(${JSON.stringify(selector)}); if (!(select instanceof HTMLSelectElement)) return false; select.value = ${JSON.stringify(value)}; return select.value === ${JSON.stringify(value)} && select.dispatchEvent(new Event('change', { bubbles: true })); })()`,
      `select option ${selector}`,
    );
  }

  async clickWithUserGesture(selector: string): Promise<void> {
    const point = await this.evaluate<{ x: number; y: number }>(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!(element instanceof HTMLElement)) return undefined; const rect = element.getBoundingClientRect(); if (rect.width <= 0 || rect.height <= 0) return undefined; return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })()`);
    if (point === undefined) {
      throw new Error(`cannot click missing or hidden selector: ${selector}`);
    }
    await this.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
    await this.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      clickCount: 1,
    });
  }

  async diagnosticCount(label: string): Promise<number | undefined> {
    return this.evaluate<number>(`(() => { const term = [...document.querySelectorAll('.pipeline-diagnostics dt')].find((element) => element.textContent === ${JSON.stringify(label)}); const value = term?.nextElementSibling?.textContent; if (value === undefined || value === null) return undefined; const parsed = Number(value); return Number.isFinite(parsed) ? parsed : undefined; })()`);
  }

  async diagnosticText(label: string): Promise<string | undefined> {
    return this.evaluate<string>(`(() => { const term = [...document.querySelectorAll('.pipeline-diagnostics dt')].find((element) => element.textContent === ${JSON.stringify(label)}); return term?.nextElementSibling?.textContent ?? undefined; })()`);
  }

  /** Reads one attribute of the first matching element (e.g. aria-label). */
  async attribute(selector: string, name: string): Promise<string | undefined> {
    return this.evaluate<string>(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); return element instanceof HTMLElement ? element.getAttribute(${JSON.stringify(name)}) ?? undefined : undefined; })()`);
  }

  async close(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      await this.send('Page.close');
    } finally {
      await this.dispose();
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      await this.cdp.send('Target.detachFromTarget', { sessionId: this.sessionId });
    } catch {
      // Page.close may already have detached the target.
    } finally {
      this.disposed = true;
      this.cdp.removeListener('Target.receivedMessageFromTarget', this.onMessage);
      this.pending.clear();
      attachedSidePanels.delete(this);
    }
  }

  private async assertAction(expression: string, description: string): Promise<void> {
    const succeeded = await this.evaluate<boolean>(expression);
    if (succeeded !== true) {
      throw new Error(`Side Panel DOM action failed: ${description}`);
    }
  }
}

const attachedSidePanels = new Set<AttachedTarget>();

/**
 * Opens the extension's REAL Side Panel and attaches to its extension target.
 */
async function openSidePanel(cdp: CDPSession, tabId: number): Promise<AttachedTarget> {
  if (context === null || extensionId === null) {
    throw new Error('extension browser context is not available');
  }

  const triggerPage = await context.newPage();
  await triggerPage.goto(`chrome-extension://${extensionId}/sidepanel.html?e2e-trigger`);
  await triggerPage.evaluate((targetTabId) => {
    const button = document.createElement('button');
    button.id = 'open-real-side-panel';
    button.addEventListener('click', () => {
      void (globalThis as unknown as {
        chrome: { sidePanel: { open(options: { tabId: number }): Promise<void> } };
      }).chrome.sidePanel.open({ tabId: targetTabId });
    });
    document.body.append(button);
  }, tabId);

  await triggerPage.locator('#open-real-side-panel').click();

  let targetId: string | null = null;

  for (let attempt = 0; attempt < 40 && targetId === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));

    const result = (await cdp.send('Target.getTargets')) as {
      targetInfos?: Array<{ type?: string; url?: string; targetId?: string }>;
    };

    const fresh = (result.targetInfos ?? []).find(
      (info) =>
        info.url === `chrome-extension://${extensionId}/sidepanel.html` &&
        info.targetId !== undefined,
    );

    if (fresh !== undefined && fresh.targetId !== undefined) {
      targetId = fresh.targetId;
    }
  }

  if (targetId === null) {
    await triggerPage.close();
    throw new Error('the extension Side Panel did not open');
  }

  await triggerPage.close();

  const attach = (await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: false,
  })) as { sessionId?: string };

  if (typeof attach.sessionId !== 'string') {
    throw new Error('failed to attach a CDP session to the extension Side Panel');
  }

  const target = new AttachedTarget(cdp, attach.sessionId);
  attachedSidePanels.add(target);
  await target.send('Runtime.enable');
  await target.send('Page.enable');

  return target;
}

// ---------------------------------------------------------------------------
// On-device translation API doubles
// ---------------------------------------------------------------------------

type TranslationDoubleMode = 'available' | 'downloadable' | 'unavailable';

/**
 * Chrome 138's experimental `Translator` / `LanguageDetector` globals shaped
 * exactly as the Fomo isolated content-script service consumes them. The
 * adapter's feature detection requires `typeof value === 'object'` with a
 * `create` function (isTranslatorCtor / isLanguageDetectorCtor), so the
 * doubles are plain OBJECTS — a class would be rejected and the coordinator
 * would degrade to `unavailable`. The double records its call counts on
 * `window.__fomoTranslationDouble` so the tests can assert `create()` ran.
 *
 * `downloadable` reports `downloadable` for the FIRST availability call and
 * `available` afterwards — simulating the model finishing its download after
 * the user clicks "Enable local translation" (spec 9.4).
 */
const buildTranslationDoubleSource = (mode: TranslationDoubleMode): string => `(() => {
  'use strict';
  const mode = ${JSON.stringify(mode)};
  const state = { mode, availabilityCalls: 0, createCalls: 0, translateCalls: 0, detectCalls: 0, activationRejected: 0 };
  window.__fomoTranslationDouble = state;
  const translator = {
    async create() {
      state.createCalls += 1;
      if (mode === 'downloadable' && state.activationRejected === 0) {
        state.activationRejected += 1;
        const error = new Error('Translator model needs user activation.');
        error.name = 'InvalidStateError';
        throw error;
      }
      return {
        translate: async () => {
          state.translateCalls += 1;
          return ${JSON.stringify(TRANSLATED_THESIS)};
        },
        destroy: () => {},
      };
    },
    async availability() {
      state.availabilityCalls += 1;
      if (mode === 'unavailable') return 'unavailable';
      // Remain 'downloadable' until create() has rejected once with an
      // activation error. This survives extra effect runs while settings are
      // still loading in the Side Panel, and flips to 'available' on retry.
      if (mode === 'downloadable' && state.activationRejected === 0) return 'downloadable';
      return 'available';
    },
  };
  const languageDetector = {
    async create() {
      return {
        detect: async () => {
          state.detectCalls += 1;
          return [{ detectedLanguage: 'en', confidence: 1 }];
        },
        destroy: () => {},
      };
    },
  };
  window.Translator = translator;
  window.LanguageDetector = languageDetector;
})();`;

/**
 * Installs the double in Fomo's extension-owned ISOLATED world. This is the
 * production execution boundary: the Side Panel only routes commands, while
 * the Fomo content script owns native AI sessions and observes trusted page
 * gestures. CDP exposes that isolated execution context after Runtime.enable;
 * no MAIN-world bridge is used for translation.
 */
const installTranslationDouble = async (
  cdp: CDPSession,
  mode: TranslationDoubleMode,
): Promise<void> => {
  const contexts: Array<{ id?: number; origin?: string; auxData?: { type?: string } }> = [];
  const onContext = (event: { context: { id?: number; origin?: string; auxData?: { type?: string } } }): void => {
    contexts.push(event.context);
  };
  cdp.on('Runtime.executionContextCreated', onContext);
  try {
    await cdp.send('Runtime.enable');
    await expect
      .poll(
        () => contexts.some((context) => context.origin === `chrome-extension://${extensionId}` && context.id !== undefined),
        { timeout: 15_000 },
      )
      .toBe(true);
    const isolated = contexts.find(
      (context) => context.origin === `chrome-extension://${extensionId}` && context.id !== undefined,
    );
    if (isolated?.id === undefined) throw new Error('Fomo content-script execution context is unavailable');
    await cdp.send('Runtime.evaluate', {
      expression: buildTranslationDoubleSource(mode),
      contextId: isolated.id,
      awaitPromise: true,
    });
    const installed = await cdp.send('Runtime.evaluate', {
      expression: 'typeof globalThis.Translator === "object"',
      contextId: isolated.id,
      returnByValue: true,
    }) as { result?: { value?: unknown } };
    if (installed.result?.value !== true) {
      throw new Error('translation double was not installed in the Fomo content-script world');
    }
  } finally {
    cdp.removeListener('Runtime.executionContextCreated', onContext);
  }
};

test.describe('Fomo Live Feed extension', () => {
  test.afterEach(async () => {
    await Promise.all([...attachedSidePanels].map((panel) => panel.close()));
  });

  test('production manifest keeps the Side Panel and explicit least-privilege contract', () => {
    const manifest = JSON.parse(
      readFileSync(path.join(EXTENSION_DIR, 'manifest.json'), 'utf8'),
    ) as {
      action?: { default_popup?: string };
      side_panel?: { default_path?: string };
      minimum_chrome_version?: string;
      permissions?: string[];
      host_permissions?: string[];
    };

    expect(manifest.action).toBeDefined();
    expect(manifest.action?.default_popup).toBeUndefined();
    expect(manifest.side_panel?.default_path).toBe('sidepanel.html');
    expect(manifest.minimum_chrome_version).toBe('138');
    expect([...(manifest.permissions ?? [])].sort()).toEqual(['sidePanel', 'storage']);
    expect(manifest.host_permissions).toEqual(EXPECTED_EXPLICIT_HOSTS);
  });

  test('delivers live activity to Side Panel history without injecting trading-page UI', async () => {
    expect(extensionId).not.toBeNull();

    const fomoPage = await context!.newPage();
    const tradingPage = await context!.newPage();

    await fomoPage.goto(fomoUrl());
    await tradingPage.goto(tradingUrl());

    await expect(tradingPage.locator('#fomo-live-feed-toast-host')).toHaveCount(0);

    expect(await fomoPage.evaluate(() => window.location.origin)).toBe(
      'https://fomo.family',
    );

    const cdp = await context!.newCDPSession(fomoPage);

    // 1. One buy event is persisted for the Side Panel.
    await emit(fomoPage, robinhoodBuy);

    // 2. Replaying the same event must not create a duplicate history row.
    await emit(fomoPage, robinhoodBuy);

    const tabId = await worker!.evaluate(async () => {
      const chromeApi = (globalThis as unknown as {
        chrome: { tabs: { query(options: { url: string }): Promise<Array<{ id?: number }>> } };
      }).chrome;
      const tabs = await chromeApi.tabs.query({ url: 'https://fomo.family/*' });
      if (tabs[0]?.id === undefined) throw new Error('Fomo fixture tab is unavailable');
      return tabs[0].id;
    });
    const panel = await openSidePanel(cdp, tabId);

    await expect.poll(async () => panel.hasText('$ROBINHOOD'), { timeout: 15_000 }).toBe(true);

    // 3. Four unique events all remain available in history.
    for (let index = 1; index <= 4; index += 1) {
      await emit(fomoPage, uniquePayload(index));
    }

    // 4. The already-open panel converges to all five persisted events.
    await expect.poll(async () => panel.cardCount(), { timeout: 15_000 }).toBe(5);
    // networkId 56 is verified-from-capture for BSC; every emitted frame renders
    // the honest 'BSC' badge and its validated CA is copyable.
    expect(await panel.hasText('BSC')).toBe(true);
    expect(await panel.hasText(robinhoodBuy.tokenAddress)).toBe(true);

    // The side panel is controls-free: no search/filter bar, chips, reset, or
    // main-view locale switcher (plan Task 4).
    expect(await panel.exists('.filter-search')).toBe(false);
    expect(await panel.exists('[data-testid="filter-toolbar-button"]')).toBe(false);
    expect(await panel.exists('[data-testid="filter-reset-button"]')).toBe(false);
    expect(await panel.exists('.active-filter-chips')).toBe(false);
    expect(await panel.exists('.locale-switcher')).toBe(false);

    // Verified BSC CA exposes a working copy action.
    expect(await panel.hasText(uniquePayload(4).tokenAddress)).toBe(true);

    await panel.click('[data-testid="settings-toggle"]');
    await expect.poll(async () => panel.hasText('Pipeline diagnostics'), { timeout: 15_000 }).toBe(true);
    expect(await panel.hasText('Observer ready')).toBe(true);
    await markSocketOpen(fomoPage);
    await expect.poll(async () => panel.hasText('Socket observed / open')).toBe(true);
    expect(await panel.hasText('Accepted')).toBe(true);

    await markSocketClosed(fomoPage);
    await expect.poll(async () => panel.hasText('Reconnecting')).toBe(true);
    await expect.poll(async () => panel.hasText('Socket observed / closed')).toBe(true);

    await panel.send('Emulation.setDeviceMetricsOverride', {
      width: 280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const layout = await panel.evaluate<{ overflow: boolean; overlap: boolean; documentWidth: number; bodyWidth: number; widest: string }>(`(() => {
      const root = document.querySelector('.sidepanel-root');
      const cards = [...document.querySelectorAll('.event-card')];
      return {
        overflow: document.documentElement.scrollWidth > 280 || document.body.scrollWidth > 280,
        overlap: cards.some((card) => { const rect = card.getBoundingClientRect(); return rect.left < 0 || rect.right > 280; }),
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        widest: [...document.querySelectorAll('*')].map((element) => ({ name: element.tagName + '.' + element.className, right: element.getBoundingClientRect().right })).sort((a, b) => b.right - a.right)[0]?.name ?? '',
      };
    })()`);
    if (layout === undefined || layout.overflow || layout.overlap) {
      throw new Error('280px layout overflow: ' + JSON.stringify(layout));
    }

    await panel.close();
    await fomoPage.close();
    await tradingPage.close();
  });

  test('ignores non-trading_activity frames and schema-invalid activity payloads', async () => {
    const fomoPage = await context!.newPage();

    await fomoPage.goto(fomoUrl());

    const cdp = await context!.newCDPSession(fomoPage);

    // Baseline history (tests share one extension profile). Wait until the
    // Side Panel finished loading, then capture the pre-existing row count.
    const tabId = await worker!.evaluate(async () => {
      const chromeApi = (globalThis as unknown as {
        chrome: { tabs: { query(options: { url: string }): Promise<Array<{ id?: number }>> } };
      }).chrome;
      const tabs = await chromeApi.tabs.query({ url: 'https://fomo.family/*' });
      if (tabs[0]?.id === undefined) throw new Error('Fomo fixture tab is unavailable');
      return tabs[0].id;
    });
    const panel = await openSidePanel(cdp, tabId);
    await expect.poll(async () => panel.feedRendered(), { timeout: 15_000 }).toBe(true);
    const baseline = await panel.cardCount();
    await panel.click('[data-testid="settings-toggle"]');
    await expect.poll(async () => panel.hasText('Pipeline diagnostics'), { timeout: 15_000 }).toBe(true);
    const rejectedBefore = await panel.diagnosticCount('Rejected');
    const persistedBefore = await panel.diagnosticCount('Persisted');
    const broadcastsBefore = await panel.diagnosticCount('Broadcast');
    expect(rejectedBefore).toBeDefined();
    expect(persistedBefore).toBeDefined();
    expect(broadcastsBefore).toBeDefined();

    // An unrelated topic frame: never a candidate.
    await fomoPage.evaluate(() => {
      (window as unknown as { __fomoEmitRawFrame(frame: string): void }).__fomoEmitRawFrame(
        JSON.stringify({ type: 'data', topicType: 'positions', payload: {} }),
      );
    });

    // A trading_activity payload that fails the runtime schema (empty user).
    await emit(fomoPage, { ...robinhoodBuy, id: 'invalid-1', userId: '' });

    // Malformed JSON: never a candidate.
    await fomoPage.evaluate(() => {
      (window as unknown as { __fomoEmitRawFrame(frame: string): void }).__fomoEmitRawFrame(
        'not-json',
      );
    });

    // The rejected counter is the deterministic pipeline barrier: once it
    // increments, the schema-invalid candidate has completed its worker path.
    await expect
      .poll(async () => panel.diagnosticCount('Rejected'), { timeout: 15_000 })
      .toBe(rejectedBefore! + 1);
    expect(await panel.diagnosticText('Last rejection')).toBe('Invalid schema');

    expect(await panel.cardCount()).toBe(baseline);
    expect(await panel.diagnosticCount('Persisted')).toBe(persistedBefore);
    expect(await panel.diagnosticCount('Broadcast')).toBe(broadcastsBefore);

    await panel.close();
    await fomoPage.close();
  });

  // -------------------------------------------------------------------------
  // Fixture history endpoint + recovery (plan Task 9 Step 1-2)
  //
  // Two production constraints shape the recovery assertions below, and
  // neither may be worked around by editing production source:
  //
  // 1. EVIDENCE GATE (src/fomo/history-client.ts, entrypoints/background.ts):
  //    the production history adapter is DELIBERATELY DISABLED until a real
  //    authenticated capture of GET https://prod-api.fomo.family/v2/activities/me
  //    is promoted to verified-from-capture. The worker wires
  //    unavailableHistoryClient, so the FULL recovery loop — fetch server-only
  //    events through the worker and watch them appear as rows — is not
  //    executable against the production build.
  // 2. SYNC-QUERY RESPONSE DROP (verified empirically against this runtime):
  //    the worker's sync.query handler returns a plain object, and
  //    chrome.runtime.onMessage in this Chrome/WXT environment does not
  //    deliver synchronous return values (Promise returns and sendResponse
  //    both work). The side panel's requestActivitySync/queryActivitySync
  //    therefore always sees undefined, its syncState never updates, and the
  //    RefreshButton status region stays on its idle fallback. The task's
  //    panel-level status assertions — "Recovery unavailable",
  //    "Refreshing", a 401-driven "Login required", and a 429-driven
  //    "Failed" — are consequently not observable end-to-end and are
  //    SKIPPED with the notes in the affected tests. The state-machine
  //    mapping (401/403 -> auth -> login-required, 429 -> server ->
  //    failed/retryable, malformed -> failed/permanent) is covered by
  //    tests/unit/history-client.test.ts and tests/unit/activity-sync.test.ts.
  //
  // The fixture endpoint itself is fully implemented and its contract is
  // exercised directly below (pagination, gap events, every failure mode).
  // -------------------------------------------------------------------------

  test('fixture history endpoint serves paginated server-only events and failure modes', async () => {
    const fomoPage = await context!.newPage();
    await fomoPage.goto(fomoUrl());

    server!.history.clear();
    server!.history.setEvents(
      [1, 2, 3, 4].map((index) => ({
        ...robinhoodBuy,
        id: 'history-only-' + index,
        tradeId: 'history-trade-' + index,
        ticker: 'HISTORY' + index,
        tokenAddress: '0x' + index.toString(16).padStart(40, '0'),
        createdAt: '2026-08-21T0' + index + ':00:00.000Z',
      })),
    );

    // Newest-first page 1 of 2 (contract ordering).
    const first = await fomoPage.evaluate(async () => {
      const response = await fetch('/v2/activities/me?limit=2');
      const body = (await response.json()) as {
        responseObject?: {
          activities?: Array<{ id?: string }>;
          nextCursor?: string | null;
          hasMore?: boolean;
        };
      };
      return { status: response.status, body };
    });

    expect(first.status).toBe(200);
    expect(first.body.responseObject?.activities?.map((activity) => activity.id)).toEqual([
      'history-only-4',
      'history-only-3',
    ]);
    expect(first.body.responseObject?.nextCursor).toBe('page:2');
    expect(first.body.responseObject?.hasMore).toBe(true);

    // Follow the opaque cursor to the terminal page.
    const second = await fomoPage.evaluate(async (cursor) => {
      const response = await fetch(
        '/v2/activities/me?limit=2&cursor=' + encodeURIComponent(cursor as string),
      );
      const body = (await response.json()) as {
        responseObject?: {
          activities?: Array<{ id?: string }>;
          nextCursor?: string | null;
          hasMore?: boolean;
        };
      };
      return { status: response.status, body };
    }, first.body.responseObject?.nextCursor ?? '');

    expect(second.status).toBe(200);
    expect(second.body.responseObject?.activities?.map((activity) => activity.id)).toEqual([
      'history-only-2',
      'history-only-1',
    ]);
    expect(second.body.responseObject?.nextCursor).toBeNull();
    expect(second.body.responseObject?.hasMore).toBe(false);

    // A single large page exposes the whole server-only queue (the gap
    // events that a recovery backfill would fetch).
    const allIds = await fomoPage.evaluate(async () => {
      const response = await fetch('/v2/activities/me?limit=50');
      const body = (await response.json()) as {
        responseObject?: { activities?: Array<{ id?: string }> };
      };
      return (body.responseObject?.activities ?? []).map((activity) => activity.id);
    });
    expect(allIds).toEqual([
      'history-only-4',
      'history-only-3',
      'history-only-2',
      'history-only-1',
    ]);

    // Simulated failures the production adapter maps to sync states.
    for (const [status, expected] of [
      ['401', 401],
      ['403', 403],
      ['429', 429],
    ] as const) {
      const code = await fomoPage.evaluate(async (mode) => {
        const response = await fetch('/v2/activities/me?status=' + mode);
        return response.status;
      }, status);
      expect(code).toBe(expected);
    }

    // Malformed: a 200 page whose activity fails the shared raw schema.
    const malformed = await fomoPage.evaluate(async () => {
      const response = await fetch('/v2/activities/me?status=malformed');
      const body = (await response.json()) as {
        responseObject?: { activities?: Array<{ id?: string }> };
      };
      return { status: response.status, body };
    });
    expect(malformed.status).toBe(200);
    expect(malformed.body.responseObject?.activities).toHaveLength(1);
    expect(malformed.body.responseObject?.activities?.[0]?.id).toBe('');

    // Network delay: the server holds the response for delayMs, so the
    // round trip cannot complete earlier than the timer (with clock margin).
    const started = Date.now();
    await fomoPage.evaluate(async () => {
      const response = await fetch('/v2/activities/me?delayMs=500');
      return response.status;
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);

    // A cursor the fixture cannot parse is rejected loudly.
    const badCursor = await fomoPage.evaluate(async () => {
      const response = await fetch('/v2/activities/me?cursor=not-a-cursor');
      return response.status;
    });
    expect(badCursor).toBe(400);

    await fomoPage.close();
  });

  test('reconnects without reloading the panel and keeps the live rows while recovery reports the disabled adapter', async () => {
    await seedStoredSettings({ uiLocale: 'en' });

    const fomoPage = await context!.newPage();

    await fomoPage.goto(fomoUrl());

    const cdp = await context!.newCDPSession(fomoPage);

    const panel = await openSidePanel(cdp, await fomoTabId());
    await expect.poll(async () => panel.feedRendered(), { timeout: 15_000 }).toBe(true);

    const baseline = await panel.cardCount();

    // Keep the pipeline diagnostics open: its Broadcast counter is the
    // deterministic activity-delivery barrier, and its socket line
    // proves the reconnect reached the observer.
    await panel.click('[data-testid="settings-toggle"]');
    await expect
      .poll(async () => panel.hasText('Pipeline diagnostics'), { timeout: 15_000 })
      .toBe(true);
    const broadcastsBefore = await panel.diagnosticCount('Broadcast');
    expect(broadcastsBefore).toBeDefined();
    if (broadcastsBefore === undefined) {
      throw new Error('Broadcast diagnostic count is undefined');
    }

    // 1. Observe two live events with IDs that cannot collide with events
    //    emitted by earlier tests in the shared extension profile.
    await emit(fomoPage, {
      ...robinhoodBuy,
      id: 'reconnect-live-1',
      tradeId: 'reconnect-trade-1',
      ticker: 'RECLIVE1',
      tokenAddress: '0x' + 'a'.repeat(40),
      createdAt: '2026-08-21T08:29:00.000Z',
    });
    await emit(fomoPage, {
      ...robinhoodBuy,
      id: 'reconnect-live-2',
      tradeId: 'reconnect-trade-2',
      ticker: 'RECLIVE2',
      tokenAddress: '0x' + 'b'.repeat(40),
      createdAt: '2026-08-21T08:30:00.000Z',
    });

    await expect
      .poll(async () => panel.cardCount(), { timeout: 15_000 })
      .toBe(baseline + 2);
    // Wait for both live broadcasts to be recorded in diagnostics before the
    // reconnect, otherwise a trailing health record can be mistaken for a
    // recovered-event broadcast.
    await expect
      .poll(async () => panel.diagnosticCount('Broadcast'), { timeout: 15_000 })
      .toBe(broadcastsBefore + 2);
    const broadcastsAfterLive = await panel.diagnosticCount('Broadcast');

    // 2. Disconnect the fixture socket.
    await markSocketClosed(fomoPage);
    await expect
      .poll(async () => panel.hasText('Socket observed / closed'), { timeout: 15_000 })
      .toBe(true);

    // 3. The gap: two SERVER-ONLY events land on the fixture history queue.
    //    They are never emitted via the WebSocket, so only a recovery
    //    backfill could surface them.
    server!.history.setEvents([
      {
        ...robinhoodBuy,
        id: 'server-only-1',
        tradeId: 'server-trade-1',
        ticker: 'GAP1',
        tokenAddress: '0x' + 'b'.repeat(40),
        createdAt: '2026-08-21T11:00:00.000Z',
      },
      {
        ...robinhoodBuy,
        id: 'server-only-2',
        tradeId: 'server-trade-2',
        ticker: 'GAP2',
        tokenAddress: '0x' + 'c'.repeat(40),
        createdAt: '2026-08-21T11:01:00.000Z',
      },
    ]);

    // 4. Reconnect WITHOUT reloading the panel. The reconnect reaches the
    //    observer (the diagnostics socket line proves it) and the panel's
    //    connection state returns to Connected without any reload.
    await markSocketOpen(fomoPage);
    await expect
      .poll(async () => panel.hasText('Socket observed / open'), { timeout: 15_000 })
      .toBe(true);
    await expect.poll(async () => panel.hasText('Connected'), { timeout: 15_000 }).toBe(true);

    // 5. The two live rows survive the reconnect; the server-only gap events
    //    are NOT recovered in this build (see the evidence-gate note above:
    //    the production history adapter is disabled, and the worker's
    //    sync.query reply cannot even cross the runtime boundary), so the row
    //    count is unchanged and no recovered event was broadcast. The
    //    "eventually shows 4 unique rows"
    //    sub-case of the plan is therefore not executable end-to-end and is
    //    skipped; the recovery coordinator's insert/dedupe behavior is
    //    covered by tests/unit/activity-sync.test.ts.
    expect(await panel.cardCount()).toBe(baseline + 2);
    expect(await panel.diagnosticCount('Broadcast')).toBe(broadcastsAfterLive);

    await panel.close();
    await fomoPage.close();
  });

  test('manual refresh issues a backfill through the disabled adapter without breaking the panel', async () => {
    await seedStoredSettings({ uiLocale: 'en' });

    const fomoPage = await context!.newPage();
    await fomoPage.goto(fomoUrl());

    const cdp = await context!.newCDPSession(fomoPage);
    const panel = await openSidePanel(cdp, await fomoTabId());
    await expect.poll(async () => panel.feedRendered(), { timeout: 15_000 }).toBe(true);

    // The task's "moves through Refreshing -> Recovery unavailable" status
    // transition is not visually observable end-to-end in this
    // build, for two independent reasons:
    //
    // 1. The production history adapter is disabled (evidence gate), so the
    //    coordinator completes within a single microtask and 'syncing' is
    //    skipped entirely.
    // 2. The worker's sync.query handler returns a plain OBJECT, and this
    //    Chrome/WXT runtime does not deliver synchronous return values from
    //    runtime.onMessage listeners (Promise returns and sendResponse do
    //    work) — verified empirically. The side panel's syncState therefore
    //    can never update and the RefreshButton stays on its idle fallback.
    //    The state machine itself (including every failure
    //    mapping: auth -> login-required, server -> failed/retryable) is
    //    covered by tests/unit/activity-sync.test.ts and
    //    tests/unit/history-client.test.ts.
    //
    // What IS observable end-to-end: the click reaches the worker's
    // single-flight coordinator — the coordinator broadcasts a payload-less
    // sync.changed on every state transition, which the panel's runtime
    // listener receives — and the button is never left stuck disabled.
    expect(await panel.attribute('.refresh-control [role="status"]', 'class')).toBe('visually-hidden');

    await panel.evaluate(`(() => {
      const seen = [];
      window.__syncChangedSeen = seen;
      chrome.runtime.onMessage.addListener((message) => {
        if (typeof message === 'object' && message !== null && message.type === 'sync.changed') {
          seen.push(Date.now());
        }
      });
    })()`);
    const seenBefore = (await panel.evaluate<number>('window.__syncChangedSeen.length')) ?? 0;

    await panel.click('.refresh-button');

    // The worker's coordinator runs (syncing -> recovery-unavailable), so at
    // least one sync.changed broadcast arrives at the panel after the click.
    await expect
      .poll(
        async () =>
          ((await panel.evaluate<number>('window.__syncChangedSeen.length')) ?? 0) > seenBefore,
        { timeout: 15_000 },
      )
      .toBe(true);

    // The panel is not stuck: status remains screen-reader-only and the
    // refresh button is enabled (recovery-unavailable keeps it clickable).
    expect(await panel.attribute('.refresh-control [role="status"]', 'class')).toBe('visually-hidden');
    expect(
      await panel.evaluate<boolean>(
        '(() => { const button = document.querySelector(".refresh-button"); return button instanceof HTMLButtonElement ? !button.disabled : false; })()',
      ),
    ).toBe(true);

    await panel.close();
    await fomoPage.close();
  });

  test('switches UI locale between English and Chinese without touching opinion-translation settings', async () => {
    await seedStoredSettings({
      uiLocale: 'en',
      opinionTranslation: { enabled: true, targetLanguage: 'auto' },
    });
    const before = await readStoredSettings();

    const fomoPage = await context!.newPage();
    await fomoPage.goto(fomoUrl());

    const cdp = await context!.newCDPSession(fomoPage);
    const panel = await openSidePanel(cdp, await fomoTabId());
    // Reload once to guarantee the panel reads the freshly-seeded English
    // setting instead of a stale Chinese value left by an earlier test.
    await panel.send('Page.reload', { ignoreCache: true });
    await expect.poll(async () => panel.feedRendered(), { timeout: 15_000 }).toBe(true);

    // English surface; locale switcher lives only inside Settings (plan Task 4).
    // Poll because a prior test may have left storage in Chinese and the panel
    // can render one frame before the seeded English setting propagates.
    await expect
      .poll(async () => panel.attribute('[data-testid="settings-toggle"]', 'aria-label'), {
        timeout: 15_000,
      })
      .toBe('Settings');
    expect(await panel.exists('.locale-switcher')).toBe(false);

    const headerButtons = await panel.evaluate<number>(
      "document.querySelectorAll('.sidepanel-header-controls button').length",
    );
    expect(headerButtons).toBe(3);
    expect(await panel.hasText('Support')).toBe(true);

    await panel.click('.sidepanel-support-toggle');
    await expect.poll(async () => panel.exists('.support-panel')).toBe(true);
    await expect.poll(async () => panel.exists('.settings-panel')).toBe(false);
    expect(
      await panel.hasText('0x373709fdbdcf272cba93164c7d0e3b87b88a1b02'),
    ).toBe(true);
    expect(
      await panel.hasText('4NrMQRjLde48FSm52UDdn2EgAvd1z7TraXpX1S44L9rj'),
    ).toBe(true);

    await panel.click('[data-testid="settings-toggle"]');
    await expect.poll(async () => panel.exists('.support-panel')).toBe(false);
    await expect.poll(async () => panel.exists('.settings-panel')).toBe(true);
    await expect.poll(async () => panel.hasText('Language'), { timeout: 15_000 }).toBe(true);

    expect(await panel.exists('.settings-translation-initialize')).toBe(false);
    expect(await panel.exists('.event-edit-label')).toBe(false);

    await panel.click('.theme-switcher-button[aria-label="Light theme"]');
    await expect.poll(async () => panel.attribute('.sidepanel-root', 'data-theme')).toBe('light');
    expect((await readStoredSettings()).uiTheme).toBe('light');

    // Switch to Chinese via the EN / 中文 switcher inside Settings.
    await panel.click('.locale-switcher-button[aria-pressed="false"]');
    await expect.poll(async () => panel.hasText('语言'), { timeout: 15_000 }).toBe(true);
    expect(await panel.hasText('Language')).toBe(false);
    expect(await panel.attribute('[data-testid="settings-toggle"]', 'aria-label')).toBe('设置');

    // Only the UI locale changed: opinion translation (and every other
    // stored setting) is byte-for-byte unchanged (spec 9.2).
    const after = await readStoredSettings();
    expect(after.uiLocale).toBe('zh-CN');
    expect(after.opinionTranslation).toEqual(before.opinionTranslation);
    expect({ ...after, uiLocale: 'en', uiTheme: before.uiTheme }).toEqual(before);

    await panel.click('.theme-switcher-button[aria-label="\u6df1\u8272\u4e3b\u9898"]');
    await expect.poll(async () => panel.attribute('.sidepanel-root', 'data-theme')).toBe('dark');

    await panel.close();
    await fomoPage.close();
  });

  // -------------------------------------------------------------------------
  // On-device opinion translation (plan Task 7 UI, spec 9.2-9.4)
  // -------------------------------------------------------------------------

  test('renders the original English thesis with its local translation below', async () => {
    await seedStoredSettings({
      uiLocale: 'en',
      opinionTranslation: { enabled: true, targetLanguage: 'zh' },
    });

    const fomoPage = await context!.newPage();
    await fomoPage.goto(fomoUrl());

    const cdp = await context!.newCDPSession(fomoPage);
    await installTranslationDouble(cdp, 'available');
    await fomoPage.bringToFront();
    const panel = await openSidePanel(cdp, await fomoTabId());

    await fomoPage.bringToFront();
    await emit(fomoPage, thesisPayload(1));

    // The original remains visible and the automatic translation is appended
    // below it; the Side Panel has no per-card translation toggle.
    await expect
      .poll(async () => panel.evaluate<string>('document.querySelector(\'[data-event-id*="thesis-1"]\')?.textContent'), { timeout: 15_000 })
      .toContain(TRANSLATED_THESIS);
    expect(await panel.evaluate<string>('document.querySelector(\'[data-event-id*="thesis-1"]\')?.textContent')).toContain('Rotation into L1s 1');
    expect(await panel.exists('[data-event-id*="thesis-1"] .event-thesis-toggle')).toBe(false);

    await panel.close();
    await fomoPage.close();
  });

  test('falls back automatically when the local model still needs activation', async () => {
    await seedStoredSettings({
      uiLocale: 'en',
      opinionTranslation: { enabled: true, targetLanguage: 'zh' },
    });

    const fomoPage = await context!.newPage();
    await fomoPage.goto(fomoUrl());

    const cdp = await context!.newCDPSession(fomoPage);
    await installTranslationDouble(cdp, 'downloadable');
    await fomoPage.bringToFront();
    const panel = await openSidePanel(cdp, await fomoTabId());

    await fomoPage.bringToFront();
    await emit(fomoPage, thesisPayload(2));

    // The local double cannot create a downloadable model without a gesture.
    // The Google gateway supplies the translation automatically instead.
    await expect
      .poll(async () => panel.evaluate<string>('document.querySelector(\'[data-event-id*="thesis-2"]\')?.textContent'), { timeout: 15_000 })
      .toContain('Rotation into L1s 2');
    await expect
      .poll(async () => panel.evaluate<string>('document.querySelector(\'[data-event-id*="thesis-2"]\')?.textContent'), { timeout: 15_000 })
      .toContain(TRANSLATED_THESIS);

    await panel.close();
    await fomoPage.close();
  });

  test('falls back automatically when the local translation model is unavailable', async () => {
    await seedStoredSettings({
      uiLocale: 'en',
      opinionTranslation: { enabled: true, targetLanguage: 'zh' },
    });

    const fomoPage = await context!.newPage();
    await fomoPage.goto(fomoUrl());

    const cdp = await context!.newCDPSession(fomoPage);
    await installTranslationDouble(cdp, 'unavailable');
    await fomoPage.bringToFront();
    const panel = await openSidePanel(cdp, await fomoTabId());

    await fomoPage.bringToFront();
    await emit(fomoPage, thesisPayload(3));

    // Local availability is unavailable, but the original and automatic
    // Google fallback translation both remain visible.
    await expect
      .poll(async () => panel.evaluate<string>('document.querySelector(\'[data-event-id*="thesis-3"]\')?.textContent'), { timeout: 15_000 })
      .toContain('Rotation into L1s 3');
    await expect
      .poll(async () => panel.evaluate<string>('document.querySelector(\'[data-event-id*="thesis-3"]\')?.textContent'), { timeout: 15_000 })
      .toContain(TRANSLATED_THESIS);
    expect(
      await panel.evaluate<boolean>('document.querySelector(\'[data-event-id*="thesis-3"] .event-thesis-toggle\') === null'),
    ).toBe(true);
    expect(
      await panel.evaluate<boolean>('document.querySelector(\'[data-event-id*="thesis-3"] .event-thesis-activate\') === null'),
    ).toBe(true);
    await panel.close();
    await fomoPage.close();
  });
});
