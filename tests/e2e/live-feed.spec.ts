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
 * isolated bridge -> service worker ingest -> overlay broadcast ->
 * closed-shadow toast, plus the persistent Side Panel history read path.
 *
 * Two Playwright limitations shape this suite and are documented here:
 *
 * 1. Playwright cannot pierce CLOSED ShadowRoots, and the overlay mounts in a
 *    closed shadow by design (spec section 4.4). Toast assertions therefore
 *    read the shadow tree through the CDP DOM domain (pierce: true), which
 *    operates at the renderer level and sees closed shadow roots.
 * 2. Playwright does not expose Chrome's Side Panel as a normal Page. The
 *    suite therefore opens the REAL panel through chrome.sidePanel.open()
 *    and drives its extension target through a CDP-attached session.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(here, 'fixtures');
const EXTENSION_DIR = path.resolve(here, '../../.output/chrome-mv3');
const EXPECTED_EXPLICIT_HOSTS = [
  'https://fomo.family/*',
  'https://www.fomo.family/*',
  'https://dexscreener.com/*',
  'https://gmgn.ai/*',
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
    args: [
      `--disable-extensions-except=${EXTENSION_DIR}`,
      `--load-extension=${EXTENSION_DIR}`,
      `--proxy-server=127.0.0.1:${server.port}`,
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
// CDP helpers for the closed-shadow toast stack on the trading page
// ---------------------------------------------------------------------------

interface CdpNode {
  nodeId: number;
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  attributes?: string[];
  children?: CdpNode[];
  shadowRoots?: CdpNode[];
}

interface ToastCard {
  nodeId: number;
  text: string;
}

function hasClass(attributes: string[] | undefined, className: string): boolean {
  if (attributes === undefined) {
    return false;
  }

  for (let index = 0; index + 1 < attributes.length; index += 2) {
    if (
      attributes[index] === 'class' &&
      (attributes[index + 1] ?? '').split(/\s+/).includes(className)
    ) {
      return true;
    }
  }

  return false;
}

function subtreeText(node: CdpNode): string {
  const parts: string[] = [];

  const walk = (current: CdpNode): void => {
    if (current.nodeType === 3) {
      if (typeof current.nodeValue === 'string') {
        parts.push(current.nodeValue);
      }

      return;
    }

    for (const child of current.children ?? []) {
      walk(child);
    }

    for (const shadow of current.shadowRoots ?? []) {
      walk(shadow);
    }
  };

  walk(node);

  return parts.join('');
}

function collectToastCards(node: CdpNode | undefined, out: ToastCard[] = []): ToastCard[] {
  if (node === undefined) {
    return out;
  }

  if (
    node.nodeType === 1 &&
    node.nodeName === 'ARTICLE' &&
    hasClass(node.attributes, 'toast-card')
  ) {
    out.push({ nodeId: node.nodeId, text: subtreeText(node) });
  }

  for (const child of node.children ?? []) {
    collectToastCards(child, out);
  }

  for (const shadow of node.shadowRoots ?? []) {
    collectToastCards(shadow, out);
  }

  return out;
}

/** All .toast-card nodes reachable through the closed shadow, pierce: true. */
async function toastCards(cdp: CDPSession): Promise<ToastCard[]> {
  const document = (await cdp.send('DOM.getDocument', {
    depth: -1,
    pierce: true,
  })) as { root?: CdpNode };

  if (document.root === undefined) {
    return [];
  }

  return collectToastCards(document.root);
}

/** A card is visible when the renderer gives it a non-empty box model. */
async function toastCardVisible(cdp: CDPSession, nodeId: number): Promise<boolean> {
  try {
    const box = (await cdp.send('DOM.getBoxModel', { nodeId })) as {
      model?: { width?: number; height?: number };
    };

    return (box.model?.width ?? 0) > 0 && (box.model?.height ?? 0) > 0;
  } catch {
    return false;
  }
}

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

  /** True once the Side Panel finished loading and rendered the feed area. */
  async feedRendered(): Promise<boolean> {
    const count = await this.evaluate<number>("document.querySelectorAll('.popup-feed').length");

    return (count ?? 0) > 0;
  }

  async reload(): Promise<void> {
    await this.send('Page.enable');
    await this.send('Page.reload', { ignoreCache: true });
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
    expect(manifest.minimum_chrome_version).toBe('114');
    expect([...(manifest.permissions ?? [])].sort()).toEqual(['sidePanel', 'storage']);
    expect(manifest.host_permissions).toEqual(EXPECTED_EXPLICIT_HOSTS);
  });

  test('delivers live toasts and exposes searchable Side Panel history and diagnostics', async () => {
    expect(extensionId).not.toBeNull();

    const fomoPage = await context!.newPage();
    const tradingPage = await context!.newPage();

    await fomoPage.goto(fomoUrl());
    await tradingPage.goto(tradingUrl());

    // The overlay content script only runs on supported hosts: the mapped
    // https://dexscreener.com origin must carry our marked host element.
    await tradingPage.waitForSelector('#fomo-live-feed-toast-host', {
      state: 'attached',
      timeout: 10_000,
    });

    expect(await fomoPage.evaluate(() => window.location.origin)).toBe(
      'https://fomo.family',
    );

    const tradingCdp = await context!.newCDPSession(tradingPage);
    const cdp = await context!.newCDPSession(fomoPage);

    // 1. One buy event -> one visible toast on the trading page.
    await emit(fomoPage, robinhoodBuy);

    await expect
      .poll(
        async () => {
          const cards = await toastCards(tradingCdp);

          for (const card of cards) {
            if (
              card.text.includes('$ROBINHOOD') &&
              (await toastCardVisible(tradingCdp, card.nodeId))
            ) {
              return true;
            }
          }

          return false;
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    // 2. Replaying the SAME event (reconnect replay, spec section 7.1) must
    //    not create a second card.
    await emit(fomoPage, robinhoodBuy);

    await expect
      .poll(async () => (await toastCards(tradingCdp)).length, { timeout: 15_000 })
      .toBe(1);

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

    // 4. A Side Panel reload re-reads persisted history.
    await panel.reload();

    await expect.poll(async () => panel.hasText('$ROBINHOOD'), { timeout: 15_000 }).toBe(true);

    // 5. Four unique events -> exactly three visible toasts (spec section
    //    7.1 cap, acceptance 2); overflow stays in history.
    for (let index = 1; index <= 4; index += 1) {
      await emit(fomoPage, uniquePayload(index));
    }

    await expect
      .poll(
        async () => {
          const cards = await toastCards(tradingCdp);
          let visible = 0;

          for (const card of cards) {
            if (await toastCardVisible(tradingCdp, card.nodeId)) {
              visible += 1;
            }
          }

          return visible;
        },
        { timeout: 15_000 },
      )
      .toBe(3);

    // 6. History keeps all five events (first + four unique).
    await panel.reload();

    await expect.poll(async () => panel.cardCount(), { timeout: 15_000 }).toBe(5);
    expect(await panel.hasText('BSC')).toBe(true);
    expect(await panel.hasText(robinhoodBuy.tokenAddress)).toBe(true);

    await panel.setInput('.filter-search', 'TOKEN4');
    await expect.poll(async () => panel.cardCount()).toBe(1);
    await panel.setInput('.filter-search', '');
    await panel.click('.filter-toolbar-button');
    expect(await panel.hasText('All actions')).toBe(true);
    await panel.selectOption('select[aria-label="Token"]', uniquePayload(4).tokenAddress);
    await expect.poll(async () => panel.cardCount()).toBe(1);
    expect(await panel.hasText('$TOKEN4')).toBe(true);
    expect(await panel.hasText('$ROBINHOOD')).toBe(false);
    await panel.click('[aria-label="Reset filters"]');
    await expect.poll(async () => panel.cardCount()).toBe(5);

    const beforeCopyUrl = await panel.evaluate<string>('location.href');
    const clipboardProbeInstalled = await panel.evaluate<boolean>(`(() => { try { Object.defineProperty(navigator.clipboard, 'writeText', { configurable: true, value: async (text) => { globalThis.__fomoCopiedText = text; } }); return true; } catch { return false; } })()`);
    expect(clipboardProbeInstalled).toBe(true);
    await panel.clickWithUserGesture('.event-card [aria-label="Copy full address"]');
    await expect
      .poll(() => panel.evaluate<string>('globalThis.__fomoCopiedText'))
      .toBe(uniquePayload(4).tokenAddress);
    expect(await panel.evaluate<string>('location.href')).toBe(beforeCopyUrl);

    await panel.click('[aria-label="Settings"]');
    await expect.poll(async () => panel.hasText('Pipeline diagnostics')).toBe(true);
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

  test('isolates the toast stack from host-page CSS inside the closed ShadowRoot', async () => {
    const fomoPage = await context!.newPage();
    const tradingPage = await context!.newPage();

    await fomoPage.goto(fomoUrl());
    await tradingPage.goto(tradingUrl());
    await tradingPage.waitForSelector('#fomo-live-feed-toast-host', {
      state: 'attached',
      timeout: 10_000,
    });

    const tradingCdp = await context!.newCDPSession(tradingPage);
    await tradingCdp.send('DOM.enable');
    await tradingCdp.send('CSS.enable');
    const cdp = await context!.newCDPSession(fomoPage);

    await emit(fomoPage, { ...robinhoodBuy, id: 'isolation-1', ticker: 'ISOLATED' });

    // The card stays visible even though the host page declares
    // .toast-card { display: none !important }.
    await expect
      .poll(
        async () => {
          const cards = await toastCards(tradingCdp);
          const target = cards.find((card) => card.text.includes('$ISOLATED'));

          return target !== undefined && (await toastCardVisible(tradingCdp, target.nodeId));
        },
        { timeout: 15_000 },
      )
      .toBe(true);

    // The card's font must come from the shadow stylesheet, not the host
    // page's universal * { font-family: HostFont } rule.
    await expect
      .poll(
        async () => {
          const cards = await toastCards(tradingCdp);
          const target = cards.find((card) => card.text.includes('$ISOLATED'));

          if (target === undefined) {
            return '';
          }

          const style = (await tradingCdp.send('CSS.getComputedStyleForNode', {
            nodeId: target.nodeId,
          })) as { computedStyle?: Array<{ name?: string; value?: string }> };

          const font = (style.computedStyle ?? []).find(
            (entry) => entry.name === 'font-family',
          );

          return (font?.value ?? '').toLowerCase();
        },
        { timeout: 15_000 },
      )
      .not.toContain('hostfont');

    // The host element sits in light DOM with a CLOSED shadow root, and the
    // host page's own CSS (the dashed red border) still applies to it -
    // proving the isolation boundary is real in both directions.
    const hostState = await tradingPage.evaluate(() => {
      const host = document.querySelector('#fomo-live-feed-toast-host');

      if (host === null) {
        return null;
      }

      return {
        shadowClosed: host.shadowRoot === null,
        borderStyle: getComputedStyle(host).borderStyle,
      };
    });

    expect(hostState).toEqual({ shadowClosed: true, borderStyle: 'dashed' });

    await fomoPage.close();
    await tradingPage.close();
  });

  test('ignores non-trading_activity frames and schema-invalid activity payloads', async () => {
    const fomoPage = await context!.newPage();
    const tradingPage = await context!.newPage();

    await fomoPage.goto(fomoUrl());
    await tradingPage.goto(tradingUrl());
    await tradingPage.waitForSelector('#fomo-live-feed-toast-host', {
      state: 'attached',
      timeout: 10_000,
    });

    const tradingCdp = await context!.newCDPSession(tradingPage);
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
    await panel.click('[aria-label="Settings"]');
    await expect.poll(async () => panel.hasText('Pipeline diagnostics')).toBe(true);
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

    expect(await toastCards(tradingCdp)).toHaveLength(0);
    expect(await panel.cardCount()).toBe(baseline);
    expect(await panel.diagnosticCount('Persisted')).toBe(persistedBefore);
    expect(await panel.diagnosticCount('Broadcast')).toBe(broadcastsBefore);

    await panel.close();
    await fomoPage.close();
    await tradingPage.close();
  });
});
