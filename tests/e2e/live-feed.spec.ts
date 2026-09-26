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
  'https://pump.fun/*',
  'https://www.pump.fun/*',
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
  ...(index === 4 ? {
    displayName: 'A Very Long Trader Display Name That Must Stay Inside Its Row',
    ticker: 'EXTREMELYLONGTOKENSYMBOL',
    usdAmount: 98_765_432.1,
  } : { ticker: 'TOKEN' + index }),
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
 * The settings.v6 record shape the E2E suite seeds/reads through the worker.
 * Mirrors src/domain/settings.ts localSettingsV6Schema. Tests share one
 * extension profile, so every test that depends on a specific locale or
 * translation preference seeds it explicitly before opening the panel.
 */
interface StoredSettingsV6 {
  schemaVersion: 6;
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
  financialDisplay: {
    buyAmount: { fontSizePx: number; color: string };
    sellAmount: { fontSizePx: number; color: string };
    marketCap: { fontSizePx: number; color: string };
  };
  displayMode: 'sidepanel' | 'floating';
}

const DEFAULT_STORED_SETTINGS: StoredSettingsV6 = {
  schemaVersion: 6,
  notifications: { enabled: true, maxVisibleToasts: 3, durationMs: 8000, soundEnabled: false },
  filters: { mutedChains: [] },
  uiLocale: 'en',
  uiTheme: 'dark',
  opinionTranslation: { enabled: true, targetLanguage: 'auto' },
  financialDisplay: {
    buyAmount: { fontSizePx: 13, color: 'theme' },
    sellAmount: { fontSizePx: 13, color: 'theme' },
    marketCap: { fontSizePx: 13, color: 'theme' },
  },
  displayMode: 'sidepanel',
};

/** Rewrites settings.v6 through the worker's chrome.storage.local. */
const seedStoredSettings = (patch: Partial<StoredSettingsV6>): Promise<void> =>
  worker!.evaluate(async (record) => {
    const chromeApi = (globalThis as unknown as {
      chrome: { storage: { local: { set(item: Record<string, unknown>): Promise<void> } } };
    }).chrome;
    await chromeApi.storage.local.set({ 'settings.v6': record });
  }, { ...DEFAULT_STORED_SETTINGS, ...patch });

/** Reads the current settings.v6 record through the worker. */
const readStoredSettings = (): Promise<StoredSettingsV6> =>
  worker!.evaluate(async () => {
    const chromeApi = (globalThis as unknown as {
      chrome: { storage: { local: { get(key: string): Promise<Record<string, unknown>> } } };
    }).chrome;
    const stored = await chromeApi.storage.local.get('settings.v6');
    return stored['settings.v6'] as StoredSettingsV6;
  });

const deleteStoredEvents = (ids: string[]): Promise<void> =>
  worker!.evaluate(async (eventIds) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('fomo-live-feed');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const database = request.result;
        const transaction = database.transaction('events', 'readwrite');
        const store = transaction.objectStore('events');
        for (const id of eventIds) store.delete(id);
        transaction.oncomplete = () => {
          database.close();
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  }, ids);

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

interface FomoTabState {
  id?: number;
  url?: string;
  active: boolean;
}

const readFomoTabs = (): Promise<FomoTabState[]> =>
  worker!.evaluate(async () => {
    const chromeApi = (globalThis as unknown as {
      chrome: { tabs: { query(options: { url: string[] }): Promise<FomoTabState[]> } };
    }).chrome;
    return chromeApi.tabs.query({
      url: ['https://fomo.family/*', 'https://www.fomo.family/*'],
    });
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
  // from chrome.storage.local, so seed a valid V5 settings record.
  await worker.evaluate(async () => {
    const chromeApi = (globalThis as unknown as {
      chrome: { storage: { local: { set(item: Record<string, unknown>): Promise<void> } } };
    }).chrome;
    await chromeApi.storage.local.set({
      'settings.v6': {
        schemaVersion: 6,
        notifications: { enabled: true, maxVisibleToasts: 3, durationMs: 8000, soundEnabled: false },
        filters: { mutedChains: [] },
        uiLocale: 'en',
        uiTheme: 'dark',
        opinionTranslation: { enabled: true, targetLanguage: 'auto' },
        financialDisplay: {
          buyAmount: { fontSizePx: 13, color: 'theme' },
          sellAmount: { fontSizePx: 13, color: 'theme' },
          marketCap: { fontSizePx: 13, color: 'theme' },
        },
        displayMode: 'sidepanel',
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

  async clickButtonByText(text: string): Promise<void> {
    await this.assertAction(
      `(() => { const expected = ${JSON.stringify(text)}; const element = [...document.querySelectorAll('button')].find((candidate) => { const content = candidate.textContent?.trim(); return candidate.classList.contains('feed-filter-chain') ? content?.endsWith(expected) : content === expected; }); if (!(element instanceof HTMLButtonElement)) return false; element.click(); return true; })()`,
      `click button ${text}`,
    );
  }

  async setInput(selector: string, value: string): Promise<void> {
    await this.assertAction(
      `(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!(input instanceof HTMLInputElement)) return false; const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set; if (setter === undefined) return false; setter.call(input, ${JSON.stringify(value)}); return input.dispatchEvent(new Event('input', { bubbles: true })); })()`,
      `set input ${selector}`,
    );
  }

  async pressEnter(selector: string): Promise<void> {
    await this.assertAction(
      `(() => { const input = document.querySelector(${JSON.stringify(selector)}); if (!(input instanceof HTMLInputElement)) return false; return input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); })()`,
      `press Enter on ${selector}`,
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
const SETTINGS_TOGGLE = '[data-testid="settings-toggle"]';
const FLOATING_HOST_URL = (id: string | null = extensionId): string =>
  `chrome-extension://${id}/floatpanel.html`;
const isFloatingHostUrl = (
  url: string,
  id: string | null = extensionId,
): boolean => {
  const parsed = new URL(url);
  const expected = new URL(FLOATING_HOST_URL(id));
  return parsed.origin === expected.origin && parsed.pathname === expected.pathname;
};
const PIP_ACTIVATION_BUTTON = '.floating-primary-action';

interface PipDomSnapshot {
  open: boolean;
  bodyText: string;
  feedCount: number;
  eventCount: number;
  returnActionCount: number;
}

interface SurfaceSwitchObservation {
  hostReady: boolean;
  sourceTargetCount: number;
  phase?: string;
}

const delayNextSidePanelClose = (runtimeWorker: Worker): Promise<boolean> =>
  runtimeWorker.evaluate(() => {
    const sidePanel = (globalThis as unknown as {
      chrome?: {
        sidePanel?: {
          close?(options: { windowId: number }): Promise<void>;
        };
      };
    }).chrome?.sidePanel;
    const original = sidePanel?.close;
    if (sidePanel === undefined || typeof original !== 'function') return false;
    Object.defineProperty(sidePanel, 'close', {
      configurable: true,
      value: async (options: { windowId: number }) => {
        Object.defineProperty(sidePanel, 'close', {
          configurable: true,
          value: original,
        });
        await new Promise((resolve) => setTimeout(resolve, 750));
        return original.call(sidePanel, options);
      },
    });
    return true;
  });

const sidePanelTargetCount = async (
  cdp: CDPSession,
  id: string | null = extensionId,
): Promise<number> => {
  const result = await cdp.send('Target.getTargets') as {
    targetInfos?: Array<{ url?: string }>;
  };
  return (result.targetInfos ?? []).filter(
    (target) => target.url === `chrome-extension://${id}/sidepanel.html`,
  ).length;
};

async function waitForFloatingHost(
  browserContext: BrowserContext | null = context,
  id: string | null = extensionId,
): Promise<Page> {
  if (browserContext === null) throw new Error('extension browser context is unavailable');
  let host: Page | undefined;
  await expect.poll(() => {
    host = browserContext.pages().find((page) => isFloatingHostUrl(page.url(), id));
    return host !== undefined;
  }, { timeout: 15_000 }).toBe(true);
  if (host === undefined) throw new Error('floating activation host did not open');
  return host;
}

async function openFloatingHostDirectly(panel: AttachedTarget): Promise<Page> {
  await panel.evaluate(`(() => {
    globalThis.__fomoFloatOpenResult = null;
    void chrome.runtime.sendMessage({
      protocolVersion: 1,
      type: "float.open"
    }).then((result) => {
      globalThis.__fomoFloatOpenResult = result;
    });
    return true;
  })()`);
  await expect.poll(
    () => panel.evaluate('globalThis.__fomoFloatOpenResult'),
    { timeout: 15_000 },
  ).toMatchObject({ ok: true });
  return waitForFloatingHost();
}

const supportsRealDocumentPip = (host: Page): Promise<boolean> =>
  host.evaluate(() => {
    const candidate = (globalThis as typeof globalThis & {
      documentPictureInPicture?: { requestWindow?: unknown };
    }).documentPictureInPicture;
    return typeof candidate?.requestWindow === 'function';
  });

const readPipDom = (host: Page, eventId: string): Promise<PipDomSnapshot> =>
  host.evaluate((expectedEventId) => {
    const pip = (globalThis as typeof globalThis & {
      documentPictureInPicture?: { window?: Window | null };
    }).documentPictureInPicture?.window;
    if (pip === undefined || pip === null || pip.closed) {
      return {
        open: false,
        bodyText: '',
        feedCount: 0,
        eventCount: 0,
        returnActionCount: 0,
      };
    }
    const pipDocument = pip.document;
    return {
      open: true,
      bodyText: pipDocument.body.innerText,
      feedCount: pipDocument.querySelectorAll('.popup-feed').length,
      eventCount: pipDocument.querySelectorAll(
        `[data-event-id="${CSS.escape(expectedEventId)}"]`,
      ).length,
      returnActionCount: [...pipDocument.querySelectorAll('button')].filter(
        (button) => button.textContent?.trim() === 'Return to Side Panel',
      ).length,
    };
  }, eventId);

const clickPipButton = async (host: Page, label: string): Promise<void> => {
  const clicked = await host.evaluate((expectedLabel) => {
    const pip = (globalThis as typeof globalThis & {
      documentPictureInPicture?: { window?: Window | null };
    }).documentPictureInPicture?.window;
    const button = pip === undefined || pip === null
      ? undefined
      : [...pip.document.querySelectorAll('button')].find(
        (candidate) => candidate.textContent?.trim() === expectedLabel,
      );
    if (button?.tagName !== 'BUTTON') return false;
    (button as HTMLButtonElement).click();
    return true;
  }, label);
  if (!clicked) throw new Error(`Document PiP button is unavailable: ${label}`);
};

const closeDocumentPip = async (host: Page): Promise<void> => {
  if (host.isClosed()) return;
  await host.evaluate(() => {
    const pip = (globalThis as typeof globalThis & {
      documentPictureInPicture?: { window?: Window | null };
    }).documentPictureInPicture?.window;
    if (pip !== undefined && pip !== null && !pip.closed) pip.close();
  }).catch(() => {});
};

async function switchToFloatingHost(
  panel: AttachedTarget,
  cdp: CDPSession,
  eventId: string,
  browserContext: BrowserContext | null = context,
  id: string | null = extensionId,
  assertReadyBeforeClose: boolean = false,
): Promise<Page> {
  await ensureSettingsOpen(panel);
  await panel.clickWithUserGesture(
    '.settings-display-mode-switcher .display-mode-switcher-button:nth-of-type(2)',
  );
  const host = await waitForFloatingHost(browserContext, id);

  if (assertReadyBeforeClose) {
    await expect.poll(async (): Promise<SurfaceSwitchObservation> => {
      const [hostReady, sourceTargetCount, transaction] = await Promise.all([
        host.locator(`[data-event-id="${eventId}"]`).count().then((count) => count === 1),
        sidePanelTargetCount(cdp, id),
        worker!.evaluate(async () => {
          const chromeApi = (globalThis as unknown as {
            chrome: { storage: { session: { get(key: string): Promise<Record<string, unknown>> } } };
          }).chrome;
          const stored = await chromeApi.storage.session.get('surfaceSwitch.transaction.v1');
          return stored['surfaceSwitch.transaction.v1'] as { phase?: string } | undefined;
        }),
      ]);
      return {
        hostReady,
        sourceTargetCount,
        ...(transaction?.phase === undefined ? {} : { phase: transaction.phase }),
      };
    }, { timeout: 15_000 }).toMatchObject({
      hostReady: true,
      sourceTargetCount: 1,
      phase: 'closing-source',
    });
  } else {
    await expect(host.locator(`[data-event-id="${eventId}"]`)).toHaveCount(1);
  }
  await expect(host.locator(PIP_ACTIVATION_BUTTON)).toBeVisible();
  await expect.poll(() => sidePanelTargetCount(cdp, id), { timeout: 15_000 }).toBe(0);
  await panel.dispose();
  return host;
}

async function ensureSettingsState(panel: AttachedTarget, open: boolean): Promise<void> {
  const expected = String(open);
  const current = await panel.attribute(SETTINGS_TOGGLE, 'aria-expanded');
  if (current === undefined) throw new Error('settings toggle is unavailable');
  if (current !== expected) await panel.click(SETTINGS_TOGGLE);
  await expect.poll(
    () => panel.attribute(SETTINGS_TOGGLE, 'aria-expanded'),
    { timeout: 15_000 },
  ).toBe(expected);
  await expect.poll(
    () => panel.exists('.settings-panel'),
    { timeout: 15_000 },
  ).toBe(open);
}

const ensureSettingsOpen = (panel: AttachedTarget): Promise<void> =>
  ensureSettingsState(panel, true);

const ensureSettingsClosed = (panel: AttachedTarget): Promise<void> =>
  ensureSettingsState(panel, false);

/**
 * Opens the extension's REAL Side Panel and attaches to its extension target.
 */
async function openSidePanel(
  cdp: CDPSession,
  _tabId: number,
  browserContext: BrowserContext | null = context,
  id: string | null = extensionId,
): Promise<AttachedTarget> {
  if (browserContext === null || id === null) {
    throw new Error('extension browser context is not available');
  }

  const triggerPage = await browserContext.newPage();
  await triggerPage.goto(`chrome-extension://${id}/sidepanel.html?e2e-trigger`);
  await triggerPage.evaluate(() => {
    const button = document.createElement('button');
    button.id = 'open-real-side-panel';
    button.addEventListener('click', () => {
      void (globalThis as unknown as {
        chrome: {
          windows: { getCurrent(): Promise<{ id?: number }> };
          sidePanel: { open(options: { windowId: number }): Promise<void> };
        };
      }).chrome.windows.getCurrent().then((window) => {
        if (window.id !== undefined) {
          return (globalThis as unknown as {
            chrome: { sidePanel: { open(options: { windowId: number }): Promise<void> } };
          }).chrome.sidePanel.open({ windowId: window.id });
        }
      });
    });
    document.body.append(button);
  });

  await triggerPage.locator('#open-real-side-panel').click();

  await triggerPage.close();
  return attachSidePanelTarget(cdp, id);
}

async function attachSidePanelTarget(
  cdp: CDPSession,
  id: string | null = extensionId,
): Promise<AttachedTarget> {
  if (id === null) throw new Error('extension id is unavailable');
  let targetId: string | null = null;

  for (let attempt = 0; attempt < 40 && targetId === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));

    const result = (await cdp.send('Target.getTargets')) as {
      targetInfos?: Array<{ type?: string; url?: string; targetId?: string }>;
    };

    const fresh = (result.targetInfos ?? []).find(
      (info) =>
        info.url === `chrome-extension://${id}/sidepanel.html` &&
        info.targetId !== undefined,
    );

    if (fresh !== undefined && fresh.targetId !== undefined) {
      targetId = fresh.targetId;
    }
  }

  if (targetId === null) {
    throw new Error('the extension Side Panel did not open');
  }

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

async function attachToOffscreenDocument(cdp: CDPSession): Promise<AttachedTarget> {
  if (extensionId === null) throw new Error('extension id is unavailable');
  let targetId: string | undefined;
  await expect.poll(async () => {
    const result = await cdp.send('Target.getTargets') as {
      targetInfos?: Array<{ type?: string; url?: string; targetId?: string }>;
    };
    targetId = result.targetInfos?.find(
      (info) => info.url === `chrome-extension://${extensionId}/offscreen.html`,
    )?.targetId;
    return targetId !== undefined;
  }, { timeout: 15_000 }).toBe(true);
  if (targetId === undefined) throw new Error('offscreen document target is unavailable');

  const attached = await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: false,
  }) as { sessionId?: string };
  if (attached.sessionId === undefined) throw new Error('failed to attach to offscreen document');
  const target = new AttachedTarget(cdp, attached.sessionId);
  await target.send('Runtime.enable');
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
 * `downloadable` remains unavailable to `create()` until a trusted Fomo-page
 * gesture occurs. This prevents React retries from accidentally simulating a
 * user activation and keeps the double aligned with Chrome's permission gate.
 */
const buildTranslationDoubleSource = (mode: TranslationDoubleMode): string => `(() => {
  'use strict';
  const mode = ${JSON.stringify(mode)};
  const state = { mode, availabilityCalls: 0, createCalls: 0, translateCalls: 0, detectCalls: 0, activationRejected: 0, activated: false };
  window.__fomoTranslationDouble = state;
  const activate = (event) => {
    if (event.isTrusted) state.activated = true;
  };
  // Window capture runs before the production host's document-capture
  // listener, so the double observes the same trusted activation before the
  // host retries model creation.
  window.addEventListener('pointerdown', activate, true);
  window.addEventListener('keydown', activate, true);
  const translator = {
    async create() {
      state.createCalls += 1;
      if (mode === 'downloadable' && !state.activated) {
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
      if (mode === 'downloadable' && !state.activated) return 'downloadable';
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
): Promise<number> => {
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
    return isolated.id;
  } finally {
    cdp.removeListener('Runtime.executionContextCreated', onContext);
  }
};

interface TranslationDoubleState {
  activated: boolean;
  activationRejected: number;
  availabilityCalls: number;
  createCalls: number;
  translateCalls: number;
}

const readTranslationDoubleState = async (
  cdp: CDPSession,
  contextId: number,
): Promise<TranslationDoubleState> => {
  const response = await cdp.send('Runtime.evaluate', {
    expression: 'window.__fomoTranslationDouble',
    contextId,
    returnByValue: true,
  }) as { result?: { value?: TranslationDoubleState } };
  if (response.result?.value === undefined) {
    throw new Error('translation double state is unavailable');
  }
  return response.result.value;
};

test.describe('Fomo Live Feed extension', () => {
  test.afterEach(async () => {
    await Promise.all([...attachedSidePanels].map(async (panel) => {
      await ensureSettingsClosed(panel);
      await panel.close();
    }));

    // Surface bootstrap starts capture recovery without blocking UI startup.
    // Let an in-flight tabs.query settle, then remove every fixture Fomo page
    // so one test's automatic recovery cannot leak a tab into the next test.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      await Promise.all(
        (context?.pages() ?? [])
          .filter((page) => page.url().startsWith('https://fomo.family/'))
          .map((page) => page.close()),
      );
    }
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
    expect(manifest.minimum_chrome_version).toBe('141');
    expect([...(manifest.permissions ?? [])].sort()).toEqual([
      'offscreen',
      'sidePanel',
      'storage',
    ]);
    expect(manifest.permissions).not.toContain('notifications');
    expect(manifest.permissions).not.toContain('tabs');
    expect(manifest.host_permissions).toEqual(EXPECTED_EXPLICIT_HOSTS);
  });

  test('always-on-top PiP keeps one synchronized feed across tab changes and returns atomically', async () => {
    if (context === null || extensionId === null || worker === null) {
      throw new Error('extension browser context is not available');
    }

    await seedStoredSettings({ displayMode: 'sidepanel' });
    const fomoPage = await context.newPage();
    await fomoPage.goto(fomoUrl());
    await emit(fomoPage, uniquePayload(901));
    const cdp = await context.newCDPSession(fomoPage);
    const panel = await openSidePanel(cdp, await fomoTabId());
    let host: Page | undefined;
    let reopenedPanel: AttachedTarget | undefined;
    let secondTab: Page | undefined;
    const eventId = 'fomo:overflow-901';

    try {
      await expect.poll(() => panel.hasText('$TOKEN901'), { timeout: 15_000 }).toBe(true);
      await markSocketOpen(fomoPage);
      await expect.poll(() => panel.hasText('Connected'), { timeout: 15_000 }).toBe(true);
      expect(await delayNextSidePanelClose(worker)).toBe(true);
      host = await switchToFloatingHost(
        panel,
        cdp,
        eventId,
        context,
        extensionId,
        true,
      );
      await expect.poll(async () => (await readStoredSettings()).displayMode, {
        timeout: 15_000,
      }).toBe('floating');

      const supported = await supportsRealDocumentPip(host);
      test.skip(!supported, 'This Chromium build does not expose the real Document PiP API');

      await host.locator(PIP_ACTIVATION_BUTTON).click();
      await expect.poll(() => readPipDom(host!, eventId), { timeout: 15_000 }).toMatchObject({
        open: true,
        feedCount: 1,
        eventCount: 1,
        returnActionCount: 1,
      });
      await expect(host.locator('.popup-feed')).toHaveCount(0);

      secondTab = await context.newPage();
      await secondTab.goto(tradingUrl());
      await fomoPage.bringToFront();
      await secondTab.bringToFront();
      await secondTab.goto(`${tradingUrl()}?navigated=1`);

      await expect.poll(() => readPipDom(host!, eventId), { timeout: 15_000 }).toMatchObject({
        open: true,
        feedCount: 1,
        eventCount: 1,
      });
      expect((await readPipDom(host, eventId)).bodyText).toContain('Connected');

      await clickPipButton(host, 'Return to Side Panel');
      await expect.poll(() => sidePanelTargetCount(cdp), { timeout: 15_000 }).toBe(1);
      reopenedPanel = await attachSidePanelTarget(cdp);
      await expect.poll(() => reopenedPanel!.hasText('$TOKEN901'), { timeout: 15_000 }).toBe(true);
      await expect.poll(() => host!.isClosed(), { timeout: 15_000 }).toBe(true);
      expect((await readStoredSettings()).displayMode).toBe('sidepanel');
    } finally {
      await panel.dispose();
      await reopenedPanel?.close();
      if (host !== undefined) {
        await closeDocumentPip(host);
        await host.close().catch(() => {});
      }
      await secondTab?.close();
      await fomoPage.close();
      await deleteStoredEvents([eventId]);
    }
  });

  test('always-on-top activation ignores a repeated trusted click and keeps one PiP feed', async () => {
    await seedStoredSettings({ displayMode: 'sidepanel' });
    const fomoPage = await context!.newPage();
    await fomoPage.goto(fomoUrl());
    await emit(fomoPage, uniquePayload(902));
    const cdp = await context!.newCDPSession(fomoPage);
    const panel = await openSidePanel(cdp, await fomoTabId());
    let host: Page | undefined;
    const eventId = 'fomo:overflow-902';

    try {
      await expect.poll(() => panel.hasText('$TOKEN902'), { timeout: 15_000 }).toBe(true);
      host = await switchToFloatingHost(panel, cdp, eventId);
      const supported = await supportsRealDocumentPip(host);
      test.skip(!supported, 'This Chromium build does not expose the real Document PiP API');

      await host.locator(PIP_ACTIVATION_BUTTON).click({ clickCount: 2 });
      await expect.poll(() => readPipDom(host!, eventId), { timeout: 15_000 }).toMatchObject({
        open: true,
        feedCount: 1,
        eventCount: 1,
      });
      expect(context!.pages().filter((page) => isFloatingHostUrl(page.url()))).toHaveLength(1);
      await expect(host.locator('.popup-feed')).toHaveCount(0);
    } finally {
      await panel.dispose();
      if (host !== undefined) {
        await closeDocumentPip(host);
        await host.close().catch(() => {});
      }
      await fomoPage.close();
      await deleteStoredEvents([eventId]);
    }
  });

  test('always-on-top native close restores the host recovery controls and synchronized feed', async () => {
    await seedStoredSettings({ displayMode: 'sidepanel' });
    const fomoPage = await context!.newPage();
    await fomoPage.goto(fomoUrl());
    await emit(fomoPage, uniquePayload(903));
    const cdp = await context!.newCDPSession(fomoPage);
    const panel = await openSidePanel(cdp, await fomoTabId());
    let host: Page | undefined;
    const eventId = 'fomo:overflow-903';

    try {
      await expect.poll(() => panel.hasText('$TOKEN903'), { timeout: 15_000 }).toBe(true);
      host = await switchToFloatingHost(panel, cdp, eventId);
      const supported = await supportsRealDocumentPip(host);
      test.skip(!supported, 'This Chromium build does not expose the real Document PiP API');

      await host.locator(PIP_ACTIVATION_BUTTON).click();
      await expect.poll(() => readPipDom(host!, eventId), { timeout: 15_000 }).toMatchObject({
        open: true,
        eventCount: 1,
      });
      await closeDocumentPip(host);

      await expect(host.locator('.floating-surface-host')).toHaveAttribute('data-state', 'recovery');
      await expect(host.getByRole('button', { name: 'Reopen always-on-top window' })).toBeVisible();
      await expect(host.getByRole('button', { name: 'Return to Side Panel' })).toBeVisible();
      await expect(host.locator(`[data-event-id="${eventId}"]`)).toHaveCount(1);
    } finally {
      await panel.dispose();
      if (host !== undefined) await host.close().catch(() => {});
      await fomoPage.close();
      await deleteStoredEvents([eventId]);
    }
  });

  test('always-on-top activation rejection preserves the host feed and exposes retry', async () => {
    await seedStoredSettings({ displayMode: 'sidepanel' });
    const fomoPage = await context!.newPage();
    await fomoPage.goto(fomoUrl());
    await emit(fomoPage, uniquePayload(904));
    const cdp = await context!.newCDPSession(fomoPage);
    const panel = await openSidePanel(cdp, await fomoTabId());
    let host: Page | undefined;
    const eventId = 'fomo:overflow-904';

    try {
      await expect.poll(() => panel.hasText('$TOKEN904'), { timeout: 15_000 }).toBe(true);
      host = await openFloatingHostDirectly(panel);
      await expect(host.locator(`[data-event-id="${eventId}"]`)).toHaveCount(1);
      await expect(host.locator(PIP_ACTIVATION_BUTTON)).toBeVisible();
      const supported = await supportsRealDocumentPip(host);
      test.skip(!supported, 'This Chromium build does not expose the real Document PiP API');

      // Preserve the real feature-support gate, then inject only the browser
      // rejection at the native API boundary. No ordinary popup or successful
      // fake PiP surface is substituted for Document PiP.
      await host.evaluate(() => {
        const api = (globalThis as typeof globalThis & {
          documentPictureInPicture: { requestWindow(options?: unknown): Promise<Window> };
        }).documentPictureInPicture;
        Object.defineProperty(api, 'requestWindow', {
          configurable: true,
          value: () => Promise.reject(new DOMException('User denied Picture-in-Picture', 'NotAllowedError')),
        });
      });
      await host.evaluate((selector) => {
        const button = document.querySelector(selector);
        if (!(button instanceof HTMLButtonElement)) throw new Error('activation button missing');
        button.click();
      }, PIP_ACTIVATION_BUTTON);

      await expect(host.locator('.floating-surface-host')).toHaveAttribute('data-state', 'error');
      await expect(host.getByRole('button', { name: 'Try again' })).toBeVisible();
      await expect(host.locator(`[data-event-id="${eventId}"]`)).toHaveCount(1);
      await expect.poll(() => readPipDom(host!, eventId)).toMatchObject({ open: false });
    } finally {
      await panel.dispose();
      if (host !== undefined) await host.close().catch(() => {});
      await fomoPage.close();
      await deleteStoredEvents([eventId]);
    }
  });

  test('always-on-top extension reload does not resurrect a stale PiP session or fallback window', async () => {
    if (server === null) throw new Error('fixture server is unavailable');
    const reloadProfile = mkdtempSync(path.join(os.tmpdir(), 'fomo-e2e-reload-profile-'));
    let reloadContext: BrowserContext | undefined;
    try {
      reloadContext = await chromium.launchPersistentContext(reloadProfile, {
        channel: 'chromium',
        headless: !HEADED,
        locale: 'en-US',
        args: [
          `--disable-extensions-except=${EXTENSION_DIR}`,
          `--load-extension=${EXTENSION_DIR}`,
          `--proxy-server=127.0.0.1:${server.port}`,
          '--disable-quic',
          '--ignore-certificate-errors',
          '--enable-unsafe-extension-debugging',
        ],
      });
      let reloadWorker = reloadContext.serviceWorkers()[0];
      await expect.poll(() => {
        reloadWorker = reloadContext!.serviceWorkers()[0];
        return reloadWorker !== undefined;
      }, { timeout: 15_000 }).toBe(true);
      if (reloadWorker === undefined) throw new Error('isolated extension worker is unavailable');
      const reloadExtensionId = new URL(reloadWorker.url()).host;
      await reloadWorker.evaluate(async () => {
        const chromeApi = (globalThis as unknown as {
          chrome: { storage: { session: { set(items: Record<string, unknown>): Promise<void> } } };
        }).chrome;
        await chromeApi.storage.session.set({
          'floatWindow.windowId': 987_654,
          'floatWindow.ownerWindowId': 123,
          'floatWindow.pipSession.v1': {
            sessionId: 'stale-e2e-pip-session',
            hostWindowId: 987_654,
            phase: 'ready',
          },
          'surfaceSwitch.transaction.v1': {
            switchId: 'stale-e2e-switch',
            source: 'sidepanel',
            target: 'floating',
            sourceWindowId: 123,
            phase: 'closing-target',
            startedAt: Date.now() - 1_000,
          },
        });
      });
      const reloadBrowser = reloadContext.browser();
      if (reloadBrowser === null) throw new Error('isolated Chromium browser is unavailable');
      const browserCdp = await reloadBrowser.newBrowserCDPSession();
      const beforeReloadTargets = await browserCdp.send('Target.getTargets') as {
        targetInfos?: Array<{ targetId?: string; type?: string; url?: string }>;
      };
      const backgroundUrl = `chrome-extension://${reloadExtensionId}/background.js`;
      const oldTargetId = beforeReloadTargets.targetInfos?.find(
        (target) => target.type === 'service_worker' && target.url === backgroundUrl,
      )?.targetId;
      if (oldTargetId === undefined) throw new Error('original worker target is unavailable');

      // Loading the same unpacked directory through Chrome's Extensions CDP
      // domain is the automation equivalent of the chrome://extensions reload
      // control. It preserves the extension ID and creates a fresh worker.
      const loadResult = await browserCdp.send('Extensions.loadUnpacked', {
        path: EXTENSION_DIR,
      }) as { id?: string };
      const replacementExtensionId = loadResult.id ?? reloadExtensionId;
      expect(replacementExtensionId).toBe(reloadExtensionId);
      let replacementWorker: Worker | undefined;
      await expect.poll(() => {
        replacementWorker = reloadContext!.serviceWorkers().find(
          (candidate) => candidate !== reloadWorker && candidate.url() === backgroundUrl,
        );
        return replacementWorker !== undefined;
      }, { timeout: 15_000 }).toBe(true);
      if (replacementWorker === undefined) throw new Error('replacement worker is unavailable');
      const afterReloadTargets = await browserCdp.send('Target.getTargets') as {
        targetInfos?: Array<{ targetId?: string; type?: string; url?: string }>;
      };
      expect(afterReloadTargets.targetInfos?.some((target) => (
        target.type === 'service_worker'
        && target.url === backgroundUrl
        && target.targetId !== oldTargetId
      ))).toBe(true);

      await expect.poll(() => replacementWorker!.evaluate(async () => {
        const chromeApi = (globalThis as unknown as {
          chrome: { storage: { session: { get(keys: string[]): Promise<Record<string, unknown>> } } };
        }).chrome;
        const stored = await chromeApi.storage.session.get([
          'floatWindow.windowId',
          'floatWindow.pipSession.v1',
          'surfaceSwitch.transaction.v1',
        ]);
        const host = stored['floatWindow.windowId'];
        const pip = stored['floatWindow.pipSession.v1'];
        const barrier = stored['surfaceSwitch.transaction.v1'];
        return (host === undefined || host === -1)
          && (pip === undefined || pip === -1)
          && (barrier === undefined || barrier === null);
      }), { timeout: 15_000 }).toBe(true);

      // Enter through the real Side Panel -> Settings flow after bootstrap.
      // A fresh host/PiP session must replace the stale token and remain live.
      const fomoPage = await reloadContext.newPage();
      await fomoPage.goto(fomoUrl());
      const reloadFomoTabId = await replacementWorker.evaluate(async () => {
        const chromeApi = (globalThis as unknown as {
          chrome: { tabs: { query(options: { url: string }): Promise<Array<{ id?: number }>> } };
        }).chrome;
        const tabs = await chromeApi.tabs.query({ url: 'https://fomo.family/*' });
        if (tabs[0]?.id === undefined) throw new Error('reload Fomo tab is unavailable');
        return tabs[0].id;
      });
      const reloadPageCdp = await reloadContext.newCDPSession(fomoPage);
      const reopenedPanel = await openSidePanel(
        reloadPageCdp,
        reloadFomoTabId,
        reloadContext,
        replacementExtensionId,
      );
      let freshHost: Page | undefined;
      try {
        await ensureSettingsOpen(reopenedPanel);
        await reopenedPanel.clickWithUserGesture(
          '.settings-display-mode-switcher .display-mode-switcher-button:nth-of-type(2)',
        );
        freshHost = await waitForFloatingHost(reloadContext, replacementExtensionId);
        await expect(freshHost.locator(PIP_ACTIVATION_BUTTON)).toBeVisible();
        await expect.poll(
          () => sidePanelTargetCount(reloadPageCdp, replacementExtensionId),
          { timeout: 15_000 },
        ).toBe(0);
        await reopenedPanel.dispose();
        const supported = await supportsRealDocumentPip(freshHost);
        test.skip(!supported, 'This Chromium build does not expose the real Document PiP API');
        await freshHost.locator(PIP_ACTIVATION_BUTTON).click();
        await expect.poll(() => readPipDom(freshHost!, 'no-seeded-event'), {
          timeout: 15_000,
        }).toMatchObject({ open: true, feedCount: 1 });
        let freshState: Record<string, unknown> = {};
        await expect.poll(async () => {
          freshState = await replacementWorker!.evaluate(async () => {
            const chromeApi = (globalThis as unknown as {
              chrome: { storage: { session: { get(keys: string[]): Promise<Record<string, unknown>> } } };
            }).chrome;
            return chromeApi.storage.session.get([
              'floatWindow.windowId',
              'floatWindow.pipSession.v1',
            ]);
          });
          return freshState['floatWindow.pipSession.v1'];
        }, { timeout: 15_000 }).toMatchObject({ phase: 'ready' });
        expect(freshState['floatWindow.windowId']).not.toBe(987_654);
        expect((freshState['floatWindow.pipSession.v1'] as { sessionId?: string }).sessionId)
          .not.toBe('stale-e2e-pip-session');
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(reloadContext.pages().filter(
          (page) => isFloatingHostUrl(page.url(), replacementExtensionId),
        )).toHaveLength(1);
        await expect.poll(() => readPipDom(freshHost!, 'no-seeded-event')).toMatchObject({
          open: true,
          feedCount: 1,
        });
      } finally {
        await reopenedPanel.dispose();
        if (freshHost !== undefined) {
          await closeDocumentPip(freshHost);
          await freshHost.close().catch(() => {});
        }
      }
    } finally {
      await reloadContext?.close();
      rmSync(reloadProfile, { recursive: true, force: true });
    }
  });

  test('plays one buy sound through the real offscreen controller and ignores duplicate and sell events', async () => {
    await seedStoredSettings({
      notifications: { ...DEFAULT_STORED_SETTINGS.notifications, soundEnabled: false },
    });
    const fomoPage = await context!.newPage();
    await fomoPage.goto(fomoUrl());
    const cdp = await context!.newCDPSession(fomoPage);
    const panel = await openSidePanel(cdp, await fomoTabId());
    let offscreen: AttachedTarget | undefined;

    try {
      await ensureSettingsOpen(panel);
      await panel.clickButtonByText('Alerts & translation');
      await panel.click('.settings-notifications input[type="checkbox"]');
      await expect.poll(async () => (await readStoredSettings()).notifications.soundEnabled).toBe(true);

      await ensureSettingsClosed(panel);
      await panel.click('.sidepanel-filter-toggle');
      await panel.clickButtonByText('BSC');
      await expect.poll(async () => (await readStoredSettings()).filters.mutedChains).toEqual(['bsc']);

      const buy = { ...uniquePayload(9101), id: 'sound-buy-9101', tradeId: 'sound-trade-9101' };
      await emit(fomoPage, buy);
      offscreen = await attachToOffscreenDocument(cdp);
      await expect.poll(
        () => offscreen!.evaluate<number>('globalThis.__fomoBuyAudioPlaybackCount'),
        { timeout: 15_000 },
      ).toBe(1);
      expect(await panel.exists('[data-event-id="fomo:sound-buy-9101"]')).toBe(false);

      await ensureSettingsOpen(panel);
      await panel.clickButtonByText('Advanced');
      const broadcastsBefore = await panel.diagnosticCount('Broadcast');
      if (broadcastsBefore === undefined) throw new Error('Broadcast diagnostic count is undefined');
      await emit(fomoPage, buy);
      await emit(fomoPage, {
        ...uniquePayload(9102),
        id: 'sound-sell-9102',
        tradeId: 'sound-trade-9102',
        type: 'swap_sell',
      });
      await expect.poll(
        () => panel.diagnosticCount('Broadcast'),
        { timeout: 15_000 },
      ).toBe(broadcastsBefore + 1);
      expect(await offscreen.evaluate<number>('globalThis.__fomoBuyAudioPlaybackCount')).toBe(1);
    } finally {
      await offscreen?.dispose();
      await ensureSettingsClosed(panel);
      await panel.close();
      await fomoPage.close();
      await deleteStoredEvents(['fomo:sound-buy-9101', 'fomo:sound-sell-9102']);
      await seedStoredSettings({
        notifications: { ...DEFAULT_STORED_SETTINGS.notifications, soundEnabled: false },
        filters: { mutedChains: [] },
      });
    }
  });

  test('token navigation reuses and activates the existing Fomo tab while card whitespace stays inert', async () => {
    const fomoPage = await context!.newPage();
    await fomoPage.goto(fomoUrl());
    await emit(fomoPage, robinhoodBuy);
    const cdp = await context!.newCDPSession(fomoPage);
    const panel = await openSidePanel(cdp, await fomoTabId());
    await expect.poll(async () => panel.hasText('$ROBINHOOD'), { timeout: 15_000 }).toBe(true);

    const before = await readFomoTabs();
    expect(before).toHaveLength(1);
    const originalUrl = fomoPage.url();
    await panel.click('[data-event-id="fomo:activity-1"]');
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fomoPage.url()).toBe(originalUrl);
    expect(await readFomoTabs()).toHaveLength(1);

    await panel.click('[data-event-id="fomo:activity-1"] .event-token-link');
    const target = `https://fomo.family/tokens/bnb/${robinhoodBuy.tokenAddress}`;
    await expect.poll(() => fomoPage.url(), { timeout: 15_000 }).toBe(target);
    const after = await readFomoTabs();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: before[0]?.id, url: target, active: true });

    await panel.close();
    await fomoPage.close();
  });

  test('token navigation creates exactly one Fomo tab when none exists', async () => {
    const sourcePage = await context!.newPage();
    await sourcePage.goto(fomoUrl());
    // Reuse the suite's canonical activity id so the persistent extension
    // profile does not add a row that changes later history-count assertions.
    await emit(sourcePage, robinhoodBuy);
    const cdp = await context!.newCDPSession(sourcePage);
    const panel = await openSidePanel(cdp, await fomoTabId());
    await expect.poll(async () => panel.hasText('$ROBINHOOD'), { timeout: 15_000 }).toBe(true);

    await sourcePage.goto(tradingUrl());
    await expect.poll(async () => (await readFomoTabs()).length).toBe(0);
    await panel.click('[data-event-id="fomo:activity-1"] .event-token-link');
    const target = `https://fomo.family/tokens/bnb/${robinhoodBuy.tokenAddress}`;
    await expect.poll(async () => (await readFomoTabs()).filter((tab) => tab.url === target).length, {
      timeout: 15_000,
    }).toBe(1);
    expect(await readFomoTabs()).toHaveLength(1);

    await panel.close();
    await sourcePage.close();
    for (const page of context!.pages()) {
      if (page.url() === target) await page.close();
    }
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
    expect(
      await panel.evaluate<{ amount: string; marketCap: string }>(`(() => {
        const card = document.querySelector('[data-event-id="fomo:activity-1"]');
        const normalizedText = (selector) => card?.querySelector(selector)?.textContent?.replace(/\\s+/g, ' ').trim() ?? '';
        return {
          amount: normalizedText('.event-amount'),
          marketCap: normalizedText('.event-market-cap'),
        };
      })()`),
    ).toEqual({ amount: '$1.25K', marketCap: 'MC: $4.2M' });

    // 3. Four unique events all remain available in history.
    for (let index = 1; index <= 4; index += 1) {
      await emit(fomoPage, uniquePayload(index));
    }
    await emit(fomoPage, {
      ...robinhoodBuy,
      id: 'robinhood-chain',
      tradeId: 'robinhood-chain-trade',
      ticker: 'RB',
      networkId: 4663,
    });

    // 4. The already-open panel converges to all six persisted events.
    await expect.poll(async () => panel.cardCount(), { timeout: 15_000 }).toBe(6);
    await markSocketOpen(fomoPage);
    await expect.poll(async () => panel.hasText('Connected'), { timeout: 15_000 }).toBe(true);
    await expect.poll(async () => panel.exists('.connection-banner')).toBe(false);
    await panel.send('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 720,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const density = await panel.evaluate<{
      cardHeights: number[];
      completeCards: number;
      horizontalOverflow: boolean;
    }>(`(() => {
      const cards = [...document.querySelectorAll('.event-card')];
      return {
        cardHeights: cards.slice(0, 6).map((card) => card.getBoundingClientRect().height),
        completeCards: cards.filter((card) => card.getBoundingClientRect().bottom <= window.innerHeight).length,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    })()`);
    if (density === undefined) throw new Error('feed density is unavailable');
    expect(density.horizontalOverflow).toBe(false);
    expect(density.cardHeights).toHaveLength(6);
    expect(Math.max(...density.cardHeights)).toBeLessThanOrEqual(92);
    expect(density.completeCards).toBeGreaterThanOrEqual(6);
    // networkId 56 is verified-from-capture for BSC; every emitted frame renders
    // the honest 'BSC' badge and its validated CA is copyable.
    expect(await panel.hasText('BSC')).toBe(true);
    expect(await panel.hasText('rh')).toBe(true);
    expect(await panel.hasText(robinhoodBuy.tokenAddress)).toBe(true);
    expect(await panel.attribute('[data-event-id="fomo:activity-1"] .event-profile-link', 'href')).toBe('https://fomo.family/profile/robinhood');

    // The legacy multi-row toolbar remains absent. The compact quick-filter
    // strip and the detailed popover are the only feed controls in the main view.
    expect(await panel.exists('.filter-search')).toBe(false);
    expect(await panel.exists('[data-testid="filter-toolbar-button"]')).toBe(false);
    expect(await panel.exists('[data-testid="filter-reset-button"]')).toBe(false);
    expect(await panel.exists('.active-filter-chips')).toBe(false);
    expect(await panel.exists('.locale-switcher')).toBe(false);
    expect(await panel.exists('.quick-feed-filters')).toBe(true);
    expect(await panel.exists('.sidepanel-filter-toggle')).toBe(true);

    await panel.click('.sidepanel-filter-toggle');
    await expect.poll(async () => panel.exists('.feed-filter-popover')).toBe(true);
    await panel.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await panel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    await expect.poll(async () => panel.exists('.feed-filter-popover')).toBe(false);
    await panel.click('.sidepanel-filter-toggle');
    await panel.setInput('[aria-label="Maximum market cap in K"]', '1000');
    await panel.pressEnter('[aria-label="Maximum market cap in K"]');
    await expect.poll(async () => panel.cardCount(), { timeout: 15_000 }).toBe(0);
    await panel.setInput('[aria-label="Maximum market cap in K"]', '5000');
    await panel.pressEnter('[aria-label="Maximum market cap in K"]');
    await expect.poll(async () => panel.cardCount(), { timeout: 15_000 }).toBe(6);
    await panel.click('.feed-filter-action-buy[aria-pressed="true"]');
    await expect.poll(async () => panel.cardCount(), { timeout: 15_000 }).toBe(0);
    await panel.click('.feed-filter-reset');
    await expect.poll(async () => panel.cardCount(), { timeout: 15_000 }).toBe(6);

    // Chain visibility is a persistent display-only filter. BSC is the first
    // chain control; disabling it leaves only the captured Robinhood row.
    await panel.clickButtonByText('BSC');
    await expect.poll(async () => panel.cardCount(), { timeout: 15_000 }).toBe(1);
    await expect.poll(async () => (await readStoredSettings()).filters.mutedChains).toEqual(['bsc']);
    await panel.clickButtonByText('Select all');
    await expect.poll(async () => panel.cardCount(), { timeout: 15_000 }).toBe(6);

    await panel.clickButtonByText('Deselect all');
    await expect.poll(async () => panel.hasText('No chains selected.'), { timeout: 15_000 }).toBe(true);
    expect(await panel.cardCount()).toBe(0);
    await panel.clickButtonByText('Select all chains');
    await expect.poll(async () => panel.cardCount(), { timeout: 15_000 }).toBe(6);

    const unknown = {
      ...uniquePayload(9301),
      id: 'unknown-chain-9301',
      tradeId: 'unknown-chain-trade-9301',
      networkId: 9301,
    };
    await emit(fomoPage, unknown);
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(await panel.exists('[data-event-id="fomo:unknown-chain-9301"]')).toBe(false);

    // Verified BSC CA exposes a working copy action.
    expect(await panel.hasText(uniquePayload(4).tokenAddress)).toBe(true);

    await ensureSettingsOpen(panel);
    await panel.clickButtonByText('Advanced');
    await expect.poll(async () => panel.hasText('Pipeline diagnostics'), { timeout: 15_000 }).toBe(true);
    expect(await panel.hasText('Observer ready')).toBe(true);
    await markSocketOpen(fomoPage);
    await expect.poll(async () => panel.hasText('Socket observed / open')).toBe(true);
    expect(await panel.hasText('Accepted')).toBe(true);

    await markSocketClosed(fomoPage);
    await expect.poll(async () => panel.hasText('Reconnecting')).toBe(true);
    await expect.poll(async () => panel.hasText('Socket observed / closed')).toBe(true);
    await ensureSettingsClosed(panel);

    await panel.send('Emulation.setDeviceMetricsOverride', {
      width: 280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const layout = await panel.evaluate<{
      overflow: boolean;
      overlap: boolean;
      amountsVisible: boolean;
      marketCapsVisible: boolean;
      tokenIdentitiesValid: boolean;
      headerTimeValid: boolean;
      addressCopyAlignmentValid: boolean;
      documentWidth: number;
      bodyWidth: number;
      widest: string;
    }>(`(() => {
      const cards = [...document.querySelectorAll('.event-card')];
      const layoutCard = document.querySelector('[data-event-id="fomo:overflow-4"]');
      const amounts = layoutCard === null ? [] : [...layoutCard.querySelectorAll('.event-amount')];
      const marketCaps = layoutCard === null ? [] : [...layoutCard.querySelectorAll('.event-market-cap')];
      const tokenIdentities = [...document.querySelectorAll('.event-token-identity')];
      const expectedAddress = ${JSON.stringify(uniquePayload(4).tokenAddress)};
      const isFullyVisible = (element) => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const card = element.closest('.event-card');
        if (card === null) return false;
        const cardRect = card.getBoundingClientRect();
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity) !== 0
          && rect.width > 0
          && rect.height > 0
          && rect.left >= 0
          && rect.right <= 280
          && rect.top >= 0
          && rect.bottom <= window.innerHeight
          && rect.left >= cardRect.left
          && rect.right <= cardRect.right
          && rect.top >= cardRect.top
          && rect.bottom <= cardRect.bottom;
      };
      const tokenIdentityIsValid = (identity) => {
        identity.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const symbol = identity.querySelector('.event-token-symbol');
        const chainBadge = identity.querySelector('.event-chain-badge');
        if (symbol === null || chainBadge === null) return false;
        const identityRect = identity.getBoundingClientRect();
        const symbolRect = symbol.getBoundingClientRect();
        const chainRect = chainBadge.getBoundingClientRect();
        const symbolCenterY = symbolRect.top + symbolRect.height / 2;
        const chainCenterY = chainRect.top + chainRect.height / 2;
        const isInsideIdentity = (rect) => rect.left >= identityRect.left
          && rect.right <= identityRect.right
          && rect.top >= identityRect.top
          && rect.bottom <= identityRect.bottom;
        return isFullyVisible(identity)
          && isFullyVisible(symbol)
          && isFullyVisible(chainBadge)
          && isInsideIdentity(symbolRect)
          && isInsideIdentity(chainRect)
          && Math.abs(symbolCenterY - chainCenterY) <= 2;
      };
      const headerTimeIsValid = () => {
        if (layoutCard === null) return false;
        const primary = layoutCard.querySelector('.event-trader-primary');
        const name = layoutCard.querySelector('.event-trader-name');
        const note = layoutCard.querySelector('.trader-note-add, .trader-note-chip');
        const time = layoutCard.querySelector('.event-time');
        if (primary === null || name === null || note === null || time === null) return false;
        if (layoutCard.querySelector('.event-action-line .event-time') !== null) return false;
        const primaryRect = primary.getBoundingClientRect();
        const nameRect = name.getBoundingClientRect();
        const noteRect = note.getBoundingClientRect();
        const timeRect = time.getBoundingClientRect();
        const isInsidePrimary = (rect) => rect.left >= primaryRect.left
          && rect.right <= primaryRect.right
          && rect.top >= primaryRect.top
          && rect.bottom <= primaryRect.bottom;
        const gap = timeRect.left - noteRect.right;
        const nameCenterY = nameRect.top + nameRect.height / 2;
        const noteCenterY = noteRect.top + noteRect.height / 2;
        const timeCenterY = timeRect.top + timeRect.height / 2;
        return isFullyVisible(primary)
          && isFullyVisible(name)
          && isFullyVisible(note)
          && isFullyVisible(time)
          && name.closest('.event-card') === layoutCard
          && time.closest('.event-card') === layoutCard
          && isInsidePrimary(nameRect)
          && isInsidePrimary(noteRect)
          && isInsidePrimary(timeRect)
          && gap >= 0
          && gap <= 16
          && Math.abs(noteCenterY - timeCenterY) <= 3
          && Math.abs(nameCenterY - timeCenterY) <= 2;
      };
      const addressCopyAlignmentIsValid = () => {
        if (layoutCard === null) return false;
        const label = layoutCard.querySelector('.copyable-address-label');
        const value = layoutCard.querySelector('.copyable-address-value');
        const button = layoutCard.querySelector('.copyable-address-button');
        if (label === null || value === null || button === null) return false;
        if (label === value || label === button || value === button) return false;
        const valueRect = value.getBoundingClientRect();
        const buttonRect = button.getBoundingClientRect();
        const gap = buttonRect.left - valueRect.right;
        const valueCenterY = valueRect.top + valueRect.height / 2;
        const buttonCenterY = buttonRect.top + buttonRect.height / 2;
        return isFullyVisible(label)
          && isFullyVisible(value)
          && isFullyVisible(button)
          && label.closest('.event-card') === layoutCard
          && value.closest('.event-card') === layoutCard
          && button.closest('.event-card') === layoutCard
          && value.textContent?.trim() === expectedAddress
          && !label.textContent?.includes(expectedAddress)
          && gap >= 0
          && gap <= 8
          && Math.abs(valueCenterY - buttonCenterY) <= 2;
      };
      const tokenIdentitiesValid = tokenIdentities.length > 0
        && tokenIdentities.every(tokenIdentityIsValid);
      layoutCard?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      return {
        overflow: document.documentElement.scrollWidth > 280 || document.body.scrollWidth > 280,
        overlap: cards.some((card) => { const rect = card.getBoundingClientRect(); return rect.left < 0 || rect.right > 280; }),
        amountsVisible: amounts.length > 0 && amounts.every(isFullyVisible),
        marketCapsVisible: marketCaps.length > 0 && marketCaps.every(isFullyVisible),
        tokenIdentitiesValid,
        headerTimeValid: headerTimeIsValid(),
        addressCopyAlignmentValid: addressCopyAlignmentIsValid(),
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        widest: [...document.querySelectorAll('*')].map((element) => ({ name: element.tagName + '.' + element.className, right: element.getBoundingClientRect().right })).sort((a, b) => b.right - a.right)[0]?.name ?? '',
      };
    })()`);
    if (
      layout === undefined ||
      layout.overflow ||
      layout.overlap ||
      !layout.amountsVisible ||
      !layout.marketCapsVisible ||
      !layout.tokenIdentitiesValid ||
      !layout.headerTimeValid ||
      !layout.addressCopyAlignmentValid
    ) {
      throw new Error('280px layout failure: ' + JSON.stringify(layout));
    }

    await panel.close();
    await fomoPage.close();
    await tradingPage.close();
    await deleteStoredEvents(['fomo:unknown-chain-9301']);
    await seedStoredSettings({ filters: { mutedChains: [] } });
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
    await ensureSettingsOpen(panel);
    await panel.clickButtonByText('Advanced');
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

    await ensureSettingsClosed(panel);
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
    await ensureSettingsOpen(panel);
    await panel.clickButtonByText('Advanced');
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

    await ensureSettingsClosed(panel);
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

  test('persists independent financial display settings across panel reopen', async () => {
    await seedStoredSettings({});
    const fomoPage = await context!.newPage();
    await fomoPage.goto(fomoUrl());
    const cdp = await context!.newCDPSession(fomoPage);
    let panel = await openSidePanel(cdp, await fomoTabId());

    await ensureSettingsOpen(panel);
    await panel.clickButtonByText('Sell amount');
    await panel.setInput('.financial-role-sellAmount input[type="range"]', '17');
    await panel.clickButtonByText('Market cap');
    await panel.setInput('.financial-role-marketCap input[type="color"]', '#7ea7ff');

    await expect.poll(async () => (await readStoredSettings()).financialDisplay.sellAmount.fontSizePx).toBe(17);
    await expect.poll(async () => (await readStoredSettings()).financialDisplay.marketCap.color).toBe('#7EA7FF');
    expect(
      await panel.evaluate<string>(
        'document.querySelector(".sidepanel-root")?.style.getPropertyValue("--sell-amount-font-size")',
      ),
    ).toBe('17px');

    await panel.close();
    panel = await openSidePanel(cdp, await fomoTabId());
    expect(
      await panel.evaluate<string>(
        'document.querySelector(".sidepanel-root")?.style.getPropertyValue("--sell-amount-font-size")',
      ),
    ).toBe('17px');
    expect(
      await panel.evaluate<string>(
        'document.querySelector(".sidepanel-root")?.style.getPropertyValue("--market-cap-color")',
      ),
    ).toBe('#7EA7FF');

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
    expect(headerButtons).toBe(4);
    expect(await panel.attribute('.sidepanel-support-toggle', 'title')).toBe('Donate');

    await panel.click('.sidepanel-support-toggle');
    await expect.poll(async () => panel.exists('.support-panel.utility-panel')).toBe(true);
    await expect.poll(async () => panel.exists('.settings-panel')).toBe(false);
    expect(
      await panel.hasText('0x373709fdbdcf272cba93164c7d0e3b87b88a1b02'),
    ).toBe(true);
    expect(
      await panel.hasText('4NrMQRjLde48FSm52UDdn2EgAvd1z7TraXpX1S44L9rj'),
    ).toBe(true);

    await ensureSettingsOpen(panel);
    await expect.poll(async () => panel.exists('.support-panel')).toBe(false);
    await expect.poll(async () => panel.exists('.settings-panel.utility-panel')).toBe(true);
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

    await ensureSettingsClosed(panel);
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

  test('requires explicit activation when the local model still needs activation', async () => {
    await seedStoredSettings({
      uiLocale: 'en',
      opinionTranslation: { enabled: true, targetLanguage: 'zh' },
    });

    const fomoPage = await context!.newPage();
    await fomoPage.goto(fomoUrl());

    const cdp = await context!.newCDPSession(fomoPage);
    const translationContextId = await installTranslationDouble(cdp, 'downloadable');
    await fomoPage.bringToFront();
    const panel = await openSidePanel(cdp, await fomoTabId());

    await fomoPage.bringToFront();
    await emit(fomoPage, thesisPayload(2));

    // The original remains local and visible while Chrome waits for a user
    // gesture before downloading the on-device model.
    await expect
      .poll(async () => panel.evaluate<string>('document.querySelector(\'[data-event-id*="thesis-2"]\')?.textContent'), { timeout: 15_000 })
      .toContain('Rotation into L1s 2');
    expect(
      await panel.evaluate<string>('document.querySelector(\'[data-event-id*="thesis-2"]\')?.textContent'),
    ).not.toContain(TRANSLATED_THESIS);
    await expect
      .poll(async () => panel.evaluate<string>('document.querySelector(\'[data-event-id*="thesis-2"]\')?.textContent'), { timeout: 15_000 })
      .toContain('Click anywhere in the Fomo page');

    await panel.evaluate<boolean>(`(() => {
      window.__translationReadyCount = 0;
      chrome.runtime.onMessage.addListener((message) => {
        if (message?.type === 'translation.ready') window.__translationReadyCount += 1;
      });
      return true;
    })()`);
    const beforeActivation = await readTranslationDoubleState(cdp, translationContextId);
    await fomoPage.bringToFront();
    await fomoPage.mouse.click(40, 40);
    await expect.poll(async () => (
      await readTranslationDoubleState(cdp, translationContextId)
    ).activated).toBe(true);
    await expect.poll(async () => (
      await readTranslationDoubleState(cdp, translationContextId)
    ).createCalls).toBeGreaterThan(beforeActivation.createCalls);
    expect(
      (await readTranslationDoubleState(cdp, translationContextId)).activationRejected,
    ).toBe(beforeActivation.activationRejected);
    await expect.poll(async () => panel.evaluate<number>(
      'window.__translationReadyCount ?? 0',
    )).toBeGreaterThan(0);
    await expect.poll(async () => (
      await readTranslationDoubleState(cdp, translationContextId)
    ).translateCalls, { timeout: 15_000 }).toBeGreaterThan(beforeActivation.translateCalls);
    await expect
      .poll(async () => panel.evaluate<string>('document.querySelector(\'[data-event-id*="thesis-2"]\')?.textContent'), { timeout: 15_000 })
      .toContain(TRANSLATED_THESIS);

    await panel.close();
    await fomoPage.close();
  });

  test('keeps the original local when the translation model is unavailable', async () => {
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

    // No remote translation fallback is allowed: the original stays visible
    // and the card reports that on-device translation is unavailable.
    await expect
      .poll(async () => panel.evaluate<string>('document.querySelector(\'[data-event-id*="thesis-3"]\')?.textContent'), { timeout: 15_000 })
      .toContain('Rotation into L1s 3');
    await expect
      .poll(async () => panel.evaluate<string>('document.querySelector(\'[data-event-id*="thesis-3"]\')?.textContent'), { timeout: 15_000 })
      .toContain('Translation unavailable');
    expect(
      await panel.evaluate<string>('document.querySelector(\'[data-event-id*="thesis-3"]\')?.textContent'),
    ).not.toContain(TRANSLATED_THESIS);
    expect(
      await panel.evaluate<boolean>('document.querySelector(\'[data-event-id*="thesis-3"] .event-thesis-toggle\') === null'),
    ).toBe(true);
    expect(
      await panel.evaluate<boolean>('document.querySelector(\'[data-event-id*="thesis-3"] .event-thesis-activation\') === null'),
    ).toBe(true);
    await panel.close();
    await fomoPage.close();
  });
});
