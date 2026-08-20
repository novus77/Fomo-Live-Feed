import {
  chromium,
  expect,
  test,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Worker,
} from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
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
 * closed-shadow toast, plus the popup history read path.
 *
 * Two Playwright limitations shape this suite and are documented here:
 *
 * 1. Playwright cannot pierce CLOSED ShadowRoots, and the overlay mounts in a
 *    closed shadow by design (spec section 4.4). Toast assertions therefore
 *    read the shadow tree through the CDP DOM domain (pierce: true), which
 *    operates at the renderer level and sees closed shadow roots.
 * 2. Playwright does not attach extension ACTION popups to a context's page
 *    list, and opening popup.html in a plain tab is (correctly) rejected by
 *    the popup sender guard in src/messaging/guards.ts. The suite therefore
 *    opens the REAL browser-action popup via chrome.action.openPopup() and
 *    drives it through a CDP-attached target (Runtime.evaluate / Page.reload).
 *    This exercises the exact production popup code path, sender guard
 *    included.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(here, 'fixtures');
const EXTENSION_DIR = path.resolve(here, '../../.output/chrome-mv3');

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
// CDP-attached driver for the REAL browser-action popup
// ---------------------------------------------------------------------------

/** Minimal client for a CDP session attached via Target.attachToTarget. */
class AttachedTarget {
  private readonly pending = new Map<number, (message: Record<string, unknown>) => void>();
  private nextId = 1;
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

  /** True when the popup's rendered body contains the given text. */
  async hasText(text: string): Promise<boolean> {
    const body = await this.evaluate<string>('document.body ? document.body.innerText : ""');

    return body !== undefined && body.includes(text);
  }

  /** Number of rendered history rows (.event-card). */
  async cardCount(): Promise<number> {
    const count = await this.evaluate<number>("document.querySelectorAll('.event-card').length");

    return count ?? 0;
  }

  /** True once the popup finished loading and rendered the feed area. */
  async feedRendered(): Promise<boolean> {
    const count = await this.evaluate<number>("document.querySelectorAll('.popup-feed').length");

    return (count ?? 0) > 0;
  }

  async reload(): Promise<void> {
    await this.send('Page.enable');
    await this.send('Page.reload', { ignoreCache: true });
  }

  dispose(): void {
    this.cdp.removeListener('Target.receivedMessageFromTarget', this.onMessage);
  }
}

/**
 * Opens the extension's REAL browser-action popup (chrome.action.openPopup)
 * and attaches a CDP session to the new popup target. Returns a driver.
 */
async function openPopup(cdp: CDPSession): Promise<AttachedTarget> {
  if (worker === null) {
    throw new Error('extension worker is not available');
  }

  const beforeResult = (await cdp.send('Target.getTargets')) as {
    targetInfos?: Array<{ type?: string; url?: string; targetId?: string }>;
  };

  const before = new Set(
    (beforeResult.targetInfos ?? [])
      .filter((info) => info.type === 'page' && (info.url ?? '').includes('/popup.html'))
      .map((info) => info.targetId)
      .filter((targetId): targetId is string => typeof targetId === 'string'),
  );

  await worker.evaluate(async () => {
    const chromeApi = (globalThis as unknown as {
      chrome?: { action?: { openPopup?: () => Promise<void> } };
    }).chrome;

    if (chromeApi?.action?.openPopup === undefined) {
      throw new Error('chrome.action.openPopup is unavailable in this Chrome');
    }

    await chromeApi.action.openPopup();
  });

  let targetId: string | null = null;

  for (let attempt = 0; attempt < 40 && targetId === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));

    const result = (await cdp.send('Target.getTargets')) as {
      targetInfos?: Array<{ type?: string; url?: string; targetId?: string }>;
    };

    const fresh = (result.targetInfos ?? []).find(
      (info) =>
        info.type === 'page' &&
        (info.url ?? '').includes('/popup.html') &&
        info.targetId !== undefined &&
        !before.has(info.targetId),
    );

    if (fresh !== undefined && fresh.targetId !== undefined) {
      targetId = fresh.targetId;
    }
  }

  if (targetId === null) {
    throw new Error('the extension action popup did not open');
  }

  const attach = (await cdp.send('Target.attachToTarget', {
    targetId,
    flatten: false,
  })) as { sessionId?: string };

  if (typeof attach.sessionId !== 'string') {
    throw new Error('failed to attach a CDP session to the extension popup');
  }

  const target = new AttachedTarget(cdp, attach.sessionId);
  await target.send('Runtime.enable');
  await target.send('Page.enable');

  return target;
}

test.describe('Fomo Live Feed extension', () => {
  test('delivers a live toast, persists popup history, deduplicates, and caps toasts at three', async () => {
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

    // 3. The real action popup shows the row: exactly one history entry.
    const popup = await openPopup(cdp);

    await expect.poll(async () => popup.hasText('$ROBINHOOD'), { timeout: 15_000 }).toBe(true);

    // 4. A popup reload re-reads persisted history (spec acceptance 3).
    await popup.reload();

    await expect.poll(async () => popup.hasText('$ROBINHOOD'), { timeout: 15_000 }).toBe(true);

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
    await popup.reload();

    await expect.poll(async () => popup.cardCount(), { timeout: 15_000 }).toBe(5);

    popup.dispose();
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
    // popup finished loading, then capture the pre-existing row count.
    const popup = await openPopup(cdp);
    await expect.poll(async () => popup.feedRendered(), { timeout: 15_000 }).toBe(true);
    const baseline = await popup.cardCount();

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

    // Let the pipeline settle, then assert nothing was stored or toasted.
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(await toastCards(tradingCdp)).toHaveLength(0);
    expect(await popup.cardCount()).toBe(baseline);

    popup.dispose();
    await fomoPage.close();
    await tradingPage.close();
  });
});