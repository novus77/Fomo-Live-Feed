import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { MetricSnapshotV1, TradeEventV1 } from '../domain/activity';
import type { TraderAnnotationV1 } from '../domain/annotations';
import { DEFAULT_SETTINGS, type LocalSettingsV1 } from '../domain/settings';
import { parseExtensionMessage } from '../messaging/protocol';
import {
  ANNOTATIONS_STORAGE_KEY,
  LocalPreferences,
  SETTINGS_STORAGE_KEY,
  type LocalPreferencesStorage,
} from '../storage/local-preferences';
import { createToastQueue, type ToastQueue } from './toast-queue';
import { ToastStack } from './ToastStack';

/**
 * Supported-site overlay (design spec section 4.4, plan Task 8 step 3).
 *
 * Renders the three-card toast stack inside a CLOSED ShadowRoot so host-page
 * CSS cannot leak in and shadow styles cannot leak out. The entrypoint
 * matches ONLY the supported trading hosts - never <all_urls> - and the
 * overlay never queries the host page beyond its own uniquely-marked host
 * element, so the page's wallet, form, and order state are untouched.
 *
 * The overlay listens for the worker's activity.broadcast messages, validates
 * and sanitizes the payload at this boundary (defense in depth: only known
 * fields survive), and pushes it through the pure three-card queue. When the
 * worker's suppression verdict is toast:false (muted trader, muted chain,
 * below the minimum amount), the event is still valid but NO card is shown —
 * history lives in the worker and is unaffected.
 */

export const OVERLAY_MATCHES = ['https://dexscreener.com/*', 'https://gmgn.ai/*'] as const;

export const HOST_ID = 'fomo-live-feed-toast-host';

/**
 * Marks host elements THIS overlay created. Cleanup and orphan reclamation
 * only ever remove elements carrying this attribute, so a host-page element
 * that happens to share HOST_ID is never deleted (SHOULD-FIX 8).
 */
export const HOST_MARKER_ATTRIBUTE = 'data-fomo-live-feed-host';

/** How often the overlay re-renders so expired cards disappear promptly. */
export const SWEEP_INTERVAL_MS = 1_000;

const CHAIN_KEYS = ['solana', 'ethereum', 'bsc', 'base', 'monad', 'unknown'] as const;
const ACTIONS = ['buy', 'sell', 'withdraw', 'transfer', 'thesis'] as const;
const SNAPSHOT_SOURCES = ['fomo-profile', 'fomo-leaderboard', 'unknown'] as const;

const isChainKey = (value: unknown): value is TradeEventV1['chain'] =>
  typeof value === 'string' && (CHAIN_KEYS as readonly string[]).includes(value);

const isAction = (value: unknown): value is TradeEventV1['action'] =>
  typeof value === 'string' && (ACTIONS as readonly string[]).includes(value);

const isSnapshotSource = (value: unknown): value is MetricSnapshotV1['source'] =>
  typeof value === 'string' && (SNAPSHOT_SOURCES as readonly string[]).includes(value);

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isFiniteTimestamp = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/** Keeps only known metric fields; hostile extra fields never survive. */
function sanitizeMetricSnapshot(value: unknown): MetricSnapshotV1 | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const raw = value as Record<string, unknown>;
  const fetchedAt = raw.fetchedAt;
  const source = raw.source;

  if (!isFiniteTimestamp(fetchedAt) || !isSnapshotSource(source)) {
    return undefined;
  }

  const pnl7d = raw.pnl7d;
  const winRate7d = raw.winRate7d;
  const followers = raw.followers;
  const tradeCount = raw.tradeCount;
  const averageHoldSeconds = raw.averageHoldSeconds;

  return {
    fetchedAt,
    source,
    ...(isFiniteNumber(pnl7d) ? { pnl7d } : {}),
    ...(isFiniteNumber(winRate7d) ? { winRate7d } : {}),
    ...(isFiniteNumber(followers) ? { followers } : {}),
    ...(isFiniteNumber(tradeCount) ? { tradeCount } : {}),
    ...(isFiniteNumber(averageHoldSeconds) ? { averageHoldSeconds } : {}),
  };
}

/**
 * Runtime-validates the broadcast event payload and rebuilds a TradeEventV1
 * that contains ONLY known fields. Anything malformed returns null and is
 * silently dropped - the overlay never stores or renders raw payloads.
 */
export function toTradeEvent(payload: unknown): TradeEventV1 | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return null;
  }

  const raw = payload as Record<string, unknown>;

  if (raw.schemaVersion !== 1 || raw.source !== 'fomo') {
    return null;
  }

  const id = raw.id;
  const traderId = raw.traderId;
  const traderHandle = raw.traderHandle;
  const chain = raw.chain;
  const tokenAddress = raw.tokenAddress;
  const tokenSymbol = raw.tokenSymbol;
  const action = raw.action;
  const occurredAt = raw.occurredAt;
  const receivedAt = raw.receivedAt;

  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof traderId !== 'string' ||
    traderId.length === 0 ||
    typeof traderHandle !== 'string' ||
    traderHandle.length === 0 ||
    !isChainKey(chain) ||
    typeof tokenAddress !== 'string' ||
    tokenAddress.length === 0 ||
    typeof tokenSymbol !== 'string' ||
    tokenSymbol.trim().length === 0 ||
    !isAction(action) ||
    !isFiniteTimestamp(occurredAt) ||
    !isFiniteTimestamp(receivedAt)
  ) {
    return null;
  }

  const sourceEventId = raw.sourceEventId;
  const sourceTradeId = raw.sourceTradeId;
  const traderName = raw.traderName;
  const traderAvatarUrl = raw.traderAvatarUrl;
  const networkId = raw.networkId;
  const tokenImageUrl = raw.tokenImageUrl;
  const usdAmount = raw.usdAmount;
  const marketCap = raw.marketCap;
  const price = raw.price;
  const thesis = raw.thesis;
  const readAt = raw.readAt;
  const metricSnapshot = sanitizeMetricSnapshot(raw.metricSnapshot);

  return {
    schemaVersion: 1,
    id,
    source: 'fomo',
    ...(typeof sourceEventId === 'string' ? { sourceEventId } : {}),
    ...(typeof sourceTradeId === 'string' ? { sourceTradeId } : {}),
    traderId,
    traderHandle,
    ...(typeof traderName === 'string' ? { traderName } : {}),
    ...(typeof traderAvatarUrl === 'string' ? { traderAvatarUrl } : {}),
    chain,
    ...(isFiniteTimestamp(networkId) ? { networkId } : {}),
    tokenAddress,
    tokenSymbol: tokenSymbol.trim(),
    ...(typeof tokenImageUrl === 'string' ? { tokenImageUrl } : {}),
    action,
    ...(isFiniteNumber(usdAmount) ? { usdAmount } : {}),
    ...(isFiniteNumber(marketCap) ? { marketCap } : {}),
    ...(isFiniteNumber(price) ? { price } : {}),
    ...(typeof thesis === 'string' ? { thesis } : {}),
    occurredAt,
    receivedAt,
    ...(isFiniteTimestamp(readAt) ? { readAt } : {}),
    ...(metricSnapshot !== undefined ? { metricSnapshot } : {}),
  };
}

/** The subset of browser.runtime.onMessage the overlay relies on. */
export interface OverlayRuntimeLike {
  onMessage: {
    addListener(listener: (message: unknown) => void): void;
    removeListener(listener: (message: unknown) => void): void;
  };
}

/** The subset of browser.storage the overlay relies on. */
export interface OverlayStorageLike {
  local: LocalPreferencesStorage;
  onChanged: {
    addListener(
      listener: (changes: Record<string, unknown>, areaName: string) => void,
    ): void;
    removeListener(
      listener: (changes: Record<string, unknown>, areaName: string) => void,
    ): void;
  };
}

export interface OverlayClipboardLike {
  writeText(text: string): Promise<void>;
}

export interface OverlayDependencies {
  document: Document;
  now: () => number;
  runtime: OverlayRuntimeLike;
  storage: OverlayStorageLike;
  /** Shadow-DOM stylesheet text (imported ?inline by the entrypoint). */
  styleText: string;
  clipboard?: OverlayClipboardLike;
}

const HOSTS = new WeakMap<Document, HTMLElement>();
const SHADOW_ROOTS = new WeakMap<Document, ShadowRoot>();
const NOOP_CLEANUP: () => void = () => {};

/**
 * Test seam: the overlay mounts inside a CLOSED ShadowRoot, which the spec
 * makes unreachable through host.shadowRoot. Integration tests use this to
 * assert on rendered cards without changing the production closed mode.
 */
export function overlayShadowRoot(doc: Document): ShadowRoot | undefined {
  return SHADOW_ROOTS.get(doc);
}

export function installTradingOverlay(deps: OverlayDependencies): () => void {
  const { document: doc, now } = deps;

  if (HOSTS.has(doc)) {
    return NOOP_CLEANUP;
  }

  // Removes an orphaned host left by a previous extension reload, but ONLY
  // elements we marked ourselves: a host-page element that merely shares our
  // id is never touched (SHOULD-FIX 8). This is the ONLY document query and
  // it targets our own attribute, so the host page's own DOM is untouched.
  doc.querySelector('[' + HOST_MARKER_ATTRIBUTE + ']')?.remove();

  const host = doc.createElement('div');
  host.id = HOST_ID;
  host.setAttribute(HOST_MARKER_ATTRIBUTE, '');

  const shadow = host.attachShadow({ mode: 'closed' });
  SHADOW_ROOTS.set(doc, shadow);

  const styleElement = doc.createElement('style');
  styleElement.textContent = deps.styleText;
  shadow.appendChild(styleElement);

  const mountElement = doc.createElement('div');
  shadow.appendChild(mountElement);

  const mountTarget = doc.body ?? doc.documentElement;

  if (mountTarget === null) {
    SHADOW_ROOTS.delete(doc);

    return NOOP_CLEANUP;
  }

  mountTarget.appendChild(host);
  HOSTS.set(doc, host);

  const root: Root = createRoot(mountElement);
  const preferences = new LocalPreferences(deps.storage.local);
  const clipboard = deps.clipboard ?? navigator.clipboard;

  let settings: LocalSettingsV1 = DEFAULT_SETTINGS;
  let annotations: ReadonlyMap<string, TraderAnnotationV1> = new Map();
  let queue: ToastQueue | null = null;
  let sweepId: ReturnType<typeof setInterval> | null = null;
  // Set by cleanup so an in-flight async continuation (reloadPreferences) that
  // resolves after unmount can never render into an unmounted root.
  let disposed = false;

  const createQueue = (): ToastQueue => {
    queue = createToastQueue({ durationMs: settings.notifications.durationMs, now });

    return queue;
  };

  const copyText = async (text: string): Promise<void> => {
    if (clipboard === undefined) {
      return;
    }

    try {
      await clipboard.writeText(text);
    } catch {
      // Clipboard access can fail on some pages; the toast must not break.
    }
  };

  const render = (): void => {
    if (disposed || queue === null) {
      return;
    }

    const events = queue.visible();

    root.render(
      createElement(ToastStack, {
        events,
        settings,
        annotations,
        now,
        copyText,
        onClose: (id: string) => {
          queue?.close(id);
          render();
        },
        onHoverChange: (id: string | null) => {
          queue?.setHovered(id);
          render();
        },
      }),
    );

    manageSweep(events.length > 0);
  };

  const manageSweep = (hasCards: boolean): void => {
    if (hasCards && sweepId === null) {
      sweepId = setInterval(() => {
        render();
      }, SWEEP_INTERVAL_MS);
    } else if (!hasCards && sweepId !== null) {
      clearInterval(sweepId);
      sweepId = null;
    }
  };

  const reloadPreferences = async (): Promise<void> => {
    const [nextSettings, nextAnnotations] = await Promise.all([
      preferences.getSettings(),
      preferences.listAnnotations(),
    ]);

    if (disposed) {
      return;
    }

    settings = nextSettings;
    annotations = new Map(
      nextAnnotations.map((annotation) => [annotation.traderId, annotation]),
    );

    if (queue === null) {
      createQueue();
    } else {
      // A settings change (for example a new toast duration) updates the
      // window for FUTURE cards only; cards already on screen keep their
      // remaining time (SHOULD-FIX 9).
      queue.setDuration(settings.notifications.durationMs);
    }

    render();
  };

  void reloadPreferences();

  const onMessage = (message: unknown): void => {
    const parsed = parseExtensionMessage(message);

    if (!parsed.ok || parsed.message.type !== 'activity.broadcast') {
      return;
    }

    // The worker nests the event inside the payload: build the card from
    // payload.event and honor the worker's suppression verdict — toast:false
    // keeps history (worker-side) but shows NO card here.
    if (parsed.message.payload.toast === false) {
      return;
    }

    const event = toTradeEvent(parsed.message.payload.event);

    if (event === null) {
      return;
    }

    (queue ?? createQueue()).push(event);
    render();
  };

  deps.runtime.onMessage.addListener(onMessage);

  const onStorageChanged = (
    changes: Record<string, unknown>,
    areaName: string,
  ): void => {
    if (areaName !== 'local') {
      return;
    }

    if (
      changes[SETTINGS_STORAGE_KEY] !== undefined ||
      changes[ANNOTATIONS_STORAGE_KEY] !== undefined
    ) {
      void reloadPreferences();
    }
  };

  deps.storage.onChanged.addListener(onStorageChanged);

  const cleanup = (): void => {
    disposed = true;

    if (sweepId !== null) {
      clearInterval(sweepId);
      sweepId = null;
    }

    deps.runtime.onMessage.removeListener(onMessage);
    deps.storage.onChanged.removeListener(onStorageChanged);

    root.unmount();
    host.remove();
    HOSTS.delete(doc);
    SHADOW_ROOTS.delete(doc);
    queue = null;
  };

  return cleanup;
}