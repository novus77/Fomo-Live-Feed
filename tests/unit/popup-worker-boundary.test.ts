import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TradeEventV1 } from '../../src/domain/activity';
import { DiagnosticRecorder } from '../../src/background/diagnostics';
import {
  FLOAT_GEOMETRY_STORAGE_KEY,
  FLOAT_OWNER_WINDOW_ID_SESSION_KEY,
  FLOAT_WINDOW_ID_SESSION_KEY,
  PIP_SESSION_STORAGE_KEY,
  FloatWindowManager,
} from '../../src/background/float-window';
import {
  SURFACE_SWITCH_ABANDONED_TARGET_STORAGE_KEY,
  SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY,
  SURFACE_SWITCH_STORAGE_KEY,
} from '../../src/background/surface-switch-coordinator';
import type { MessageSenderLike } from '../../src/messaging/guards';
import { popupConnectionState } from '../../src/popup/event-query';
import {
  markEventsRead,
  queryActivitySync,
  queryConnection,
  queryEvents,
  queryPipelineHealth,
  requestActivitySync,
  type PopupRuntimeLike,
} from '../../src/popup/popup-io';
import { FomoFeedDatabase } from '../../src/storage/database';
import { EventRepository } from '../../src/storage/event-repository';
import {
  installFomoBridge,
  type BridgeWindowLike,
  type WindowMessageEventLike,
} from '../../src/fomo/bridge';
import {
  installFomoWebSocketObserver,
  type MessageEventLike,
  type WebSocketConstructorLike,
} from '../../src/fomo/websocket-observer';

const NOW = 1_800_000_000_000;
const TEN_MINUTES_MS = 10 * 60 * 1_000;
const TOKEN_ADDRESS = '0x020bfc650a365f8bb26819deaabf3e21291018b4';
const EXTENSION_ID = 'boundary-test-extension-id';

function makeEvent(overrides: Partial<TradeEventV1> = {}): TradeEventV1 {
  return {
    schemaVersion: 1,
    id: 'fomo:event-1',
    source: 'fomo',
    traderId: 'trader-1',
    traderHandle: 'alpha',
    traderName: 'Alpha Whale',
    chain: 'bsc',
    tokenAddress: TOKEN_ADDRESS,
    tokenSymbol: 'FOMO',
    action: 'buy',
    occurredAt: NOW - 60_000,
    receivedAt: NOW,
    ...overrides,
  };
}

/**
 * Boundary test (plan Task 9/10 deliverable, SHOULD-FIX 7 rewrite): drives
 * the popup's REAL client functions - popup-io.queryEvents(),
 * queryConnection(), markEventsRead() - against the worker's REAL listener
 * (entrypoints/background.ts) with fakes standing in for every browser API.
 * The old test asserted the worker's raw response shape by reading it;
 * driving the clients proves the popup-side destructure, row validation, and
 * state mapping too.
 */
interface FakeBrowser {
  sidePanel: {
    open(options: { windowId: number }): Promise<void>;
    close(options: { windowId: number }): Promise<void>;
  };
  runtime: {
    id: string;
    sendMessage(message: unknown): Promise<unknown>;
    getURL(path: string): string;
    onMessage: {
      addListener(listener: (message: unknown, sender: unknown) => unknown): void;
      removeListener(listener: (message: unknown, sender: unknown) => unknown): void;
    };
  };
  storage: {
    local: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
    session: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
  };
  tabs: {
    query(query: { url?: string | string[] }): Promise<Array<{ id?: number; url?: string; windowId: number; lastAccessed?: number; active?: boolean }>>;
    update(tabId: number, update: { url: string; active: true }): Promise<unknown>;
    create(create: { url: string; active: true }): Promise<unknown>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
    onRemoved: {
      addListener(listener: (tabId: number) => void): void;
    };
    onUpdated: {
      addListener(
        listener: (tabId: number, changeInfo: { url?: string; status?: string }) => void,
      ): void;
    };
  };
  windows: {
    getLastFocused(): Promise<{ id?: number }>;
    update(
      windowId: number,
      update:
        | { focused: true }
        | { state: 'minimized' }
        | { state: 'normal' }
        | { state: 'normal'; focused: true },
    ): Promise<unknown>;
    get(windowId: number): Promise<{ id?: number }>;
    create(create: unknown): Promise<{ id?: number }>;
    remove(windowId: number): Promise<void>;
    onRemoved: {
      addListener(listener: (windowId: number) => void): void;
    };
    onBoundsChanged: {
      addListener(
        listener: (window: {
          id?: number;
          width?: number;
          height?: number;
          left?: number;
          top?: number;
        }) => void,
      ): void;
    };
  };
  action: {
    setBadgeText(details: { text: string }): Promise<void>;
    setBadgeBackgroundColor(details: { color: string }): Promise<void>;
    onClicked: {
      addListener(listener: (tab: { windowId?: number }) => void): void;
    };
  };
}

function createFakeBrowser(options: {
  fomoTabs?: number;
  pumpTabs?: number;
  activeFomoTabId?: number;
  onTabMessage?: (tabId: number, message: unknown) => unknown;
  rejectTabUpdate?: boolean;
  rejectTabCreate?: boolean;
  initialSession?: Record<string, unknown>;
  initialFloatWindowId?: number;
  onSidePanelOpen?: (windowId: number) => void;
  rejectSidePanelOpen?: boolean;
} = {}) {
  const localRecords: Record<string, unknown> = {};
  const sessionRecords: Record<string, unknown> = { ...options.initialSession };
  const badgeCalls: Array<{ text?: string; color?: string }> = [];
  const broadcasts: unknown[] = [];
  const healthChanges: unknown[] = [];
  const navigationCalls: unknown[] = [];
  const sidePanelOpenCalls: number[] = [];
  const sidePanelCloseCalls: number[] = [];
  let listener: ((message: unknown, sender: unknown) => unknown) | null = null;
  let removedListener: ((tabId: number) => void) | null = null;
  let updatedListener: ((tabId: number, changeInfo: { url?: string; status?: string }) => void) | null = null;
  let boundsChangedListener: ((window: {
    id?: number;
    width?: number;
    height?: number;
    left?: number;
    top?: number;
  }) => void) | null = null;
  let actionClickedListener: ((tab: { windowId?: number }) => void) | null = null;
  let floatWindowId: number | undefined = options.initialFloatWindowId;
  let activeFomoTabId = options.activeFomoTabId ?? 0;
  const removedTabIds = new Set<number>();
  let hydrationGate: Promise<void> | undefined;
  let releaseHydrationGate: (() => void) | undefined;

  const browser: FakeBrowser = {
    sidePanel: {
      async open({ windowId }): Promise<void> {
        sidePanelOpenCalls.push(windowId);
        options.onSidePanelOpen?.(windowId);
        if (options.rejectSidePanelOpen) throw new Error('side panel open failed');
      },
      async close({ windowId }): Promise<void> {
        sidePanelCloseCalls.push(windowId);
      },
    },
    runtime: {
      id: EXTENSION_ID,
      async sendMessage(message: unknown): Promise<unknown> {
        healthChanges.push(message);
        return undefined;
      },
      getURL(path: string): string {
        return `chrome-extension://${EXTENSION_ID}/${path}`;
      },
      onMessage: {
        addListener(fn: (message: unknown, sender: unknown) => unknown): void {
          listener = fn;
        },
        removeListener(fn: (message: unknown, sender: unknown) => unknown): void {
          if (listener === fn) {
            listener = null;
          }
        },
      },
    },
    storage: {
      local: {
        async get(keys: string[]): Promise<Record<string, unknown>> {
          const result: Record<string, unknown> = {};

          for (const key of keys) {
            if (key in localRecords) {
              result[key] = localRecords[key];
            }
          }

          return result;
        },
        async set(items: Record<string, unknown>): Promise<void> {
          Object.assign(localRecords, items);
        },
      },
      session: {
        async get(keys: string[]): Promise<Record<string, unknown>> {
          if (
            hydrationGate !== undefined
            && keys.includes(FLOAT_WINDOW_ID_SESSION_KEY)
            && keys.includes(FLOAT_OWNER_WINDOW_ID_SESSION_KEY)
            && keys.includes(PIP_SESSION_STORAGE_KEY)
          ) {
            await hydrationGate;
          }
          const result: Record<string, unknown> = {};

          for (const key of keys) {
            if (key in sessionRecords) {
              result[key] = sessionRecords[key];
            }
          }

          return result;
        },
        async set(items: Record<string, unknown>): Promise<void> {
          Object.assign(sessionRecords, items);
        },
      },
    },
    tabs: {
      async query(query): Promise<Array<{ id?: number; url?: string; windowId: number; lastAccessed?: number; active?: boolean }>> {
        const patterns = query.url === undefined
          ? []
          : Array.isArray(query.url) ? query.url : [query.url];
        const requestsPumpTabs = patterns.some((pattern) => pattern.includes('pump.fun'));
        if (requestsPumpTabs) {
          return Array.from({ length: options.pumpTabs ?? 0 }, (_, index) => 100 + index)
            .filter((tabId) => !removedTabIds.has(tabId))
            .map((tabId) => ({
              id: tabId,
              url: 'https://pump.fun/',
              windowId: 1,
              lastAccessed: tabId,
              active: false,
            }));
        }
        return Array.from({ length: options.fomoTabs ?? 0 }, (_, index) => index)
          .filter((tabId) => !removedTabIds.has(tabId))
          .map((tabId) => ({
            id: tabId,
            url: 'https://fomo.family/',
            windowId: 1,
            lastAccessed: tabId,
            active: tabId === activeFomoTabId,
          }));
      },
      async update(tabId, update): Promise<unknown> {
        navigationCalls.push({ action: 'update', tabId, update });
        if (options.rejectTabUpdate) throw new Error('sensitive update failure');
        return {};
      },
      async create(create): Promise<unknown> {
        navigationCalls.push({ action: 'create', create });
        if (options.rejectTabCreate) throw new Error('sensitive create failure');
        return {};
      },
      async sendMessage(tabId: number, message: unknown): Promise<unknown> {
        broadcasts.push(message);
        return options.onTabMessage?.(tabId, message);
      },
      onRemoved: {
        addListener(fn: (tabId: number) => void): void {
          removedListener = fn;
        },
      },
      onUpdated: {
        addListener(
          fn: (tabId: number, changeInfo: { url?: string; status?: string }) => void,
        ): void {
          updatedListener = fn;
        },
      },
    },
    windows: {
      async getLastFocused(): Promise<{ id?: number }> { return { id: 1 }; },
      async update(windowId, update): Promise<unknown> {
        navigationCalls.push({ action: 'focus', windowId, update });
        return {};
      },
      async get(windowId): Promise<{ id?: number }> {
        if (hydrationGate !== undefined) await hydrationGate;
        if (windowId !== floatWindowId) throw new Error('window not found');
        return { id: windowId };
      },
      async create(): Promise<{ id?: number }> {
        floatWindowId = 900;
        return { id: floatWindowId };
      },
      async remove(windowId): Promise<void> {
        if (windowId !== floatWindowId) throw new Error('window not found');
        floatWindowId = undefined;
      },
      onRemoved: {
        addListener(): void {},
      },
      onBoundsChanged: {
        addListener(fn): void {
          boundsChangedListener = fn;
        },
      },
    },
    action: {
      async setBadgeText(details: { text: string }): Promise<void> {
        badgeCalls.push({ text: details.text });
      },
      async setBadgeBackgroundColor(details: { color: string }): Promise<void> {
        badgeCalls.push({ color: details.color });
      },
      onClicked: {
        addListener(fn): void {
          actionClickedListener = fn;
        },
      },
    },
  };

  return {
    browser,
    localRecords,
    sessionRecords,
    badgeCalls,
    broadcasts,
    healthChanges,
    navigationCalls,
    sidePanelOpenCalls,
    sidePanelCloseCalls,
    blockLifecycleHydration(): void {
      hydrationGate = new Promise<void>((resolve) => {
        releaseHydrationGate = resolve;
      });
    },
    releaseLifecycleHydration(): void {
      releaseHydrationGate?.();
      hydrationGate = undefined;
      releaseHydrationGate = undefined;
    },
    dispatch: (message: unknown, sender: MessageSenderLike): Promise<unknown> => {
      const result = listener?.(message, sender);

      return Promise.resolve(result);
    },
    removeTab: (tabId: number): void => {
      removedTabIds.add(tabId);
      removedListener?.(tabId);
    },
    setActiveFomoTab: (tabId: number): void => { activeFomoTabId = tabId; },
    updateTabUrl: (tabId: number, url: string): void => updatedListener?.(tabId, { url }),
    startTabNavigation: (tabId: number): void => updatedListener?.(tabId, { status: 'loading' }),
    clickAction: (windowId: number): void => actionClickedListener?.({ windowId }),
    changeWindowBounds: (window: {
      id?: number;
      width?: number;
      height?: number;
      left?: number;
      top?: number;
    }): void => boundsChangedListener?.(window),
  };
}

// The popup's own sender: our extension id, no tab, no url.
const POPUP_SENDER: MessageSenderLike = { id: EXTENSION_ID };
// A Fomo content-script sender with a real tab id (per-tab connection
// state). The guard's minimal MessageSenderLike type omits tab.id, so the
// sender carries its own wider shape - the worker's listener reads
// sender.tab?.id directly.
const FOMO_TAB_SENDER: { id: string; tab: { url: string; id: number } } = {
  id: EXTENSION_ID,
  tab: { url: 'https://fomo.family/', id: 0 },
};
const PUMP_TAB_SENDER: { id: string; tab: { url: string; id: number } } = {
  id: EXTENSION_ID,
  tab: { url: 'https://pump.fun/', id: 100 },
};
const floatHostSender = (windowId: number): MessageSenderLike => {
  const url = `chrome-extension://${EXTENSION_ID}/floatpanel.html?surface=floating#pip`;
  return {
    id: EXTENSION_ID,
    url,
    tab: { id: 90, windowId, url },
  };
};

/** The popup's runtime adapter: sendMessage dispatches into the worker. */
function createPopupRuntime(fake: ReturnType<typeof createFakeBrowser>): {
  runtime: PopupRuntimeLike;
  sent: unknown[];
} {
  const sent: unknown[] = [];

  const runtime: PopupRuntimeLike = {
    async sendMessage(message: unknown): Promise<unknown> {
      sent.push(message);

      return fake.dispatch(message, POPUP_SENDER);
    },
    onMessage: {
      addListener(): void {},
      removeListener(): void {},
    },
  };

  return { runtime, sent };
}

let workerSetup: (() => void) | null = null;
const databases: FomoFeedDatabase[] = [];

async function startWorker(
  options: {
    fomoTabs?: number;
    pumpTabs?: number;
    activeFomoTabId?: number;
    onTabMessage?: (tabId: number, message: unknown) => unknown;
    rejectSidePanelSetup?: boolean;
    rejectTabUpdate?: boolean;
    rejectTabCreate?: boolean;
    initialSession?: Record<string, unknown>;
    initialFloatWindowId?: number;
    onSidePanelOpen?: (windowId: number) => void;
    rejectSidePanelOpen?: boolean;
    skipBootstrapWait?: boolean;
  } = {},
) {
  const fake = createFakeBrowser(options);

  vi.stubGlobal('defineBackground', (setup: () => void) => setup);
  vi.stubGlobal('browser', fake.browser);
  vi.stubGlobal('chrome', {
    sidePanel: {
      open: fake.browser.sidePanel.open,
      close: fake.browser.sidePanel.close,
      setPanelBehavior: options.rejectSidePanelSetup
        ? async () => {
            throw new Error('side panel setup failed');
          }
        : async () => {},
    },
  });

  const module = await import('../../entrypoints/background');
  workerSetup = module.default as unknown as () => void;

  workerSetup();

  // Let bootstrap (badge refresh, retention seed, suppression warm) settle
  // before dispatching worker messages.
  if (!options.skipBootstrapWait) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  return fake;
}

afterEach(async () => {
  for (const database of databases.splice(0)) {
    database.close();
    await database.delete();
  }

  vi.unstubAllGlobals();
  workerSetup = null;
});

describe('worker boundary: real popup clients against the real listener', () => {
  it('routes trusted matching PiP lifecycle messages into the real manager', async () => {
    const fake = await startWorker();
    const openedHost = await fake.dispatch(
      { protocolVersion: 1, type: 'float.open' },
      POPUP_SENDER,
    ) as { ok: true; windowId: number };
    fake.sessionRecords[FLOAT_OWNER_WINDOW_ID_SESSION_KEY] = 77;
    const lifecycle = (type: string, payload: Record<string, unknown>) => fake.dispatch(
      { protocolVersion: 1, type, payload },
      floatHostSender(Number(payload.hostWindowId)),
    );

    await expect(lifecycle('pip.opened', {
      sessionId: 'pip-1', hostWindowId: openedHost.windowId,
    })).resolves.toEqual({ ok: true, created: true, ownerWindowId: 77 });
    await expect(lifecycle('pip.ready', {
      sessionId: 'pip-1', hostWindowId: openedHost.windowId, eventWatermark: 12,
    })).resolves.toEqual({ ok: true, minimized: true });
    expect(fake.sessionRecords[PIP_SESSION_STORAGE_KEY]).toMatchObject({ phase: 'ready' });
    expect(fake.navigationCalls).toContainEqual({
      action: 'focus',
      windowId: openedHost.windowId,
      update: { state: 'minimized' },
    });

    await expect(lifecycle('pip.closed', {
      sessionId: 'pip-1', hostWindowId: openedHost.windowId, reason: 'native-close',
    })).resolves.toEqual({ ok: true, restored: true });
    expect(fake.navigationCalls.at(-1)).toEqual({
      action: 'focus',
      windowId: openedHost.windowId,
      update: { state: 'normal', focused: true },
    });

    await lifecycle('pip.opened', {
      sessionId: 'pip-2', hostWindowId: openedHost.windowId,
    });
    await expect(lifecycle('pip.closed', {
      sessionId: 'pip-2', hostWindowId: openedHost.windowId, reason: 'mount-failed',
    })).resolves.toEqual({ ok: true, restored: true });
  });

  it('rejects stale PiP identity and untrusted senders without changing manager state', async () => {
    const fake = await startWorker();
    const host = await fake.dispatch(
      { protocolVersion: 1, type: 'float.open' },
      POPUP_SENDER,
    ) as { ok: true; windowId: number };
    fake.sessionRecords[FLOAT_OWNER_WINDOW_ID_SESSION_KEY] = 77;
    const opened = {
      protocolVersion: 1,
      type: 'pip.opened',
      payload: { sessionId: 'pip-live', hostWindowId: host.windowId },
    };
    await fake.dispatch(opened, floatHostSender(host.windowId));
    const before = structuredClone(fake.sessionRecords[PIP_SESSION_STORAGE_KEY]);

    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'pip.ready',
      payload: { sessionId: 'pip-live', hostWindowId: host.windowId + 1, eventWatermark: 0 },
    }, floatHostSender(host.windowId + 1))).resolves.toEqual({
      ok: false,
      reason: 'host-mismatch',
    });
    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'pip.closed',
      payload: { sessionId: 'pip-old', hostWindowId: host.windowId, reason: 'native-close' },
    }, floatHostSender(host.windowId))).resolves.toEqual({
      ok: false,
      reason: 'session-mismatch',
    });
    await expect(fake.dispatch(opened, POPUP_SENDER)).resolves.toBeUndefined();
    await expect(fake.dispatch(opened, {
      ...floatHostSender(host.windowId + 1),
      tab: {
        ...floatHostSender(host.windowId + 1).tab,
        windowId: host.windowId + 1,
      },
    })).resolves.toBeUndefined();
    await expect(fake.dispatch(opened, FOMO_TAB_SENDER)).resolves.toBeUndefined();
    await expect(fake.dispatch(opened, {
      id: EXTENSION_ID,
      url: 'https://attacker.example/popup.html',
    })).resolves.toBeUndefined();

    expect(fake.sessionRecords[PIP_SESSION_STORAGE_KEY]).toEqual(before);
    expect(fake.navigationCalls).toEqual([]);
  });

  it('opens the side panel synchronously for a matching return and completes via surface.ready', async () => {
    let crossedMicrotask = false;
    const observedAtOpen: boolean[] = [];
    const fake = await startWorker({
      onSidePanelOpen: () => observedAtOpen.push(crossedMicrotask),
    });
    const host = await fake.dispatch(
      { protocolVersion: 1, type: 'float.open' },
      POPUP_SENDER,
    ) as { ok: true; windowId: number };
    fake.sessionRecords[FLOAT_OWNER_WINDOW_ID_SESSION_KEY] = 77;
    await fake.dispatch({
      protocolVersion: 1,
      type: 'pip.opened',
      payload: { sessionId: 'pip-live', hostWindowId: host.windowId },
    }, floatHostSender(host.windowId));
    await fake.dispatch({
      protocolVersion: 1,
      type: 'surface.bootstrap',
      payload: { surface: 'sidepanel', windowId: 88, instanceToken: 'other-panel' },
    }, POPUP_SENDER);

    queueMicrotask(() => { crossedMicrotask = true; });
    const returned = fake.dispatch({
      protocolVersion: 1,
      type: 'pip.returnToSidePanel',
      payload: {
        sessionId: 'pip-live', hostWindowId: host.windowId, ownerWindowId: 77,
        switchId: 'switch-return',
      },
    }, floatHostSender(host.windowId));

    expect(observedAtOpen).toEqual([false]);
    await vi.waitFor(() => expect(fake.healthChanges).toContainEqual({
      protocolVersion: 1,
      type: 'surface.switch.started',
      payload: { switchId: 'switch-return', target: 'sidepanel' },
    }));
    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'surface.bootstrap',
      payload: { surface: 'sidepanel', windowId: 88, instanceToken: 'other-panel' },
    }, POPUP_SENDER)).resolves.toEqual({ ok: true });
    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'surface.bootstrap',
      payload: { surface: 'sidepanel', windowId: 77, instanceToken: 'panel-return' },
    }, POPUP_SENDER)).resolves.toEqual({
      ok: true,
      transaction: expect.objectContaining({
        switchId: 'switch-return',
        sourceWindowId: 77,
        sourceIdentity: {
          hostWindowId: host.windowId,
          sessionId: 'pip-live',
        },
      }),
    });
    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'surface.ready',
      payload: {
        switchId: 'switch-return', surface: 'sidepanel', eventWatermark: 12,
        windowId: 88, instanceToken: 'other-panel',
      },
    }, POPUP_SENDER)).resolves.toEqual({
      ok: false,
      switchId: 'switch-return',
      reason: 'stale-switch',
    });
    expect(fake.sessionRecords[FLOAT_WINDOW_ID_SESSION_KEY]).toBe(host.windowId);
    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'surface.ready',
      payload: {
        switchId: 'switch-return', surface: 'sidepanel', eventWatermark: 12,
        windowId: 77, instanceToken: 'panel-return',
      },
    }, POPUP_SENDER)).resolves.toEqual({ ok: true, switchId: 'switch-return' });
    await expect(returned).resolves.toEqual({ ok: true, switchId: 'switch-return' });
    expect(fake.sessionRecords[FLOAT_WINDOW_ID_SESSION_KEY]).toBe(-1);
    expect(fake.healthChanges).toContainEqual({
      protocolVersion: 1,
      type: 'surface.switch.changed',
      payload: { ok: true, switchId: 'switch-return' },
    });

    const restoreCount = fake.navigationCalls.filter((call) => (
      (call as { update?: unknown }).update as { state?: string } | undefined
    )?.state === 'normal').length;
    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'pip.closed',
      payload: {
        sessionId: 'pip-live', hostWindowId: host.windowId, reason: 'return-to-sidepanel',
      },
    }, floatHostSender(host.windowId))).resolves.toMatchObject({ ok: false });
    expect(fake.navigationCalls.filter((call) => (
      (call as { update?: unknown }).update as { state?: string } | undefined
    )?.state === 'normal')).toHaveLength(restoreCount);
  });

  it('keeps a replacement PiP host when startup reconciles an older closing-source', async () => {
    const replacementSession = {
      sessionId: 'pip-replacement',
      hostWindowId: 901,
      phase: 'ready',
    };
    const fake = await startWorker({
      initialFloatWindowId: 901,
      initialSession: {
        [FLOAT_WINDOW_ID_SESSION_KEY]: 901,
        [FLOAT_OWNER_WINDOW_ID_SESSION_KEY]: 88,
        [PIP_SESSION_STORAGE_KEY]: replacementSession,
        [SURFACE_SWITCH_STORAGE_KEY]: {
          switchId: 'old-return-cleanup',
          source: 'floating',
          target: 'sidepanel',
          sourceWindowId: 77,
          sourceIdentity: { hostWindowId: 900, sessionId: 'pip-original' },
          phase: 'closing-source',
          startedAt: 0,
        },
      },
    });

    await vi.waitFor(() => expect(fake.sessionRecords[SURFACE_SWITCH_STORAGE_KEY]).toMatchObject({
      phase: 'closing-target',
    }));
    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'surface.bootstrap',
      payload: { surface: 'sidepanel', windowId: 88, instanceToken: 'panel-replacement' },
    }, POPUP_SENDER)).resolves.toEqual({ ok: true });
    expect(fake.sessionRecords).toMatchObject({
      [FLOAT_WINDOW_ID_SESSION_KEY]: 901,
      [FLOAT_OWNER_WINDOW_ID_SESSION_KEY]: 88,
      [PIP_SESSION_STORAGE_KEY]: replacementSession,
      [SURFACE_SWITCH_STORAGE_KEY]: expect.objectContaining({
        switchId: 'old-return-cleanup',
        phase: 'closing-target',
      }),
    });
  });

  it('does not close a replacement side panel while restoring an older target cleanup', async () => {
    const fake = await startWorker({
      initialSession: {
        [SURFACE_SWITCH_STORAGE_KEY]: {
          switchId: 'old-sidepanel-target',
          source: 'floating',
          target: 'sidepanel',
          sourceWindowId: 77,
          sourceIdentity: { hostWindowId: 900, sessionId: 'pip-original' },
          targetIdentity: { hostWindowId: 77, instanceToken: 'panel-original' },
          phase: 'closing-target',
          startedAt: 0,
        },
      },
    });

    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'surface.bootstrap',
      payload: { surface: 'sidepanel', windowId: 77, instanceToken: 'panel-replacement' },
    }, POPUP_SENDER)).resolves.toEqual({ ok: true });
    expect(fake.sidePanelCloseCalls).toEqual([]);
    expect(fake.sessionRecords[SURFACE_SWITCH_STORAGE_KEY]).toBeNull();
  });

  it('does not close an unregistered timed-out side-panel replacement', async () => {
    const fake = await startWorker({
      initialFloatWindowId: 900,
      initialSession: {
        [FLOAT_WINDOW_ID_SESSION_KEY]: 900,
        [FLOAT_OWNER_WINDOW_ID_SESSION_KEY]: 77,
      },
    });
    vi.useFakeTimers();
    try {
      await fake.dispatch({
        protocolVersion: 1,
        type: 'surface.bootstrap',
        payload: { surface: 'sidepanel', windowId: 77, instanceToken: 'stale-existing-panel' },
      }, POPUP_SENDER);
      await fake.dispatch({
        protocolVersion: 1,
        type: 'surface.bootstrap',
        payload: { surface: 'floating', windowId: 900, instanceToken: 'float-timeout' },
      }, POPUP_SENDER);
      const returned = fake.dispatch({
        protocolVersion: 1,
        type: 'surface.switch.request',
        payload: {
          switchId: 'timed-out-owner-return',
          source: 'floating',
          target: 'sidepanel',
          sourceWindowId: 900,
          instanceToken: 'float-timeout',
        },
      }, POPUP_SENDER);
      await vi.advanceTimersByTimeAsync(10_000);

      await expect(returned).resolves.toEqual({
        ok: false,
        switchId: 'timed-out-owner-return',
        reason: 'target-close-failed',
      });
      expect(fake.sidePanelOpenCalls).toEqual([77]);
      expect(fake.sidePanelCloseCalls).toEqual([]);
      await expect(fake.dispatch({
        protocolVersion: 1,
        type: 'surface.bootstrap',
        payload: { surface: 'sidepanel', windowId: 88, instanceToken: 'stale-panel' },
      }, POPUP_SENDER)).resolves.toEqual({ ok: true });
      expect(fake.sidePanelCloseCalls).toEqual([]);
      expect(fake.sessionRecords[SURFACE_SWITCH_STORAGE_KEY]).toMatchObject({
        targetIdentity: { hostWindowId: 77 },
      });
      await expect(fake.dispatch({
        protocolVersion: 1,
        type: 'surface.bootstrap',
        payload: { surface: 'sidepanel', windowId: 77, instanceToken: 'late-target' },
      }, POPUP_SENDER)).resolves.toEqual({ ok: true });
      expect(fake.sidePanelCloseCalls).toEqual([77]);
      expect(fake.sessionRecords[SURFACE_SWITCH_STORAGE_KEY]).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not open a generic target before startup restores its cleanup barrier', async () => {
    const fake = await startWorker({
      skipBootstrapWait: true,
      initialSession: {
        [SURFACE_SWITCH_STORAGE_KEY]: {
          switchId: 'stored-cleanup-barrier',
          source: 'floating',
          target: 'sidepanel',
          sourceWindowId: 77,
          phase: 'closing-target',
          startedAt: Date.now(),
        },
      },
    });

    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'surface.switch.request',
      payload: {
        switchId: 'immediate-generic-request',
        source: 'floating',
        target: 'sidepanel',
        sourceWindowId: 900,
        instanceToken: 'blocked-source',
      },
    }, POPUP_SENDER)).resolves.toEqual({
      ok: false,
      switchId: 'immediate-generic-request',
      reason: 'switch-in-progress',
    });
    expect(fake.sidePanelOpenCalls).toEqual([]);
  });

  it('admits a fresh return after an unbootstrapped side-panel target expires', async () => {
    const fake = await startWorker({
      initialFloatWindowId: 900,
      initialSession: {
        [FLOAT_WINDOW_ID_SESSION_KEY]: 900,
        [FLOAT_OWNER_WINDOW_ID_SESSION_KEY]: 77,
        [PIP_SESSION_STORAGE_KEY]: {
          sessionId: 'pip-unidentified-target',
          hostWindowId: 900,
          phase: 'ready',
        },
      },
    });
    vi.useFakeTimers();
    try {
      await fake.dispatch({
        protocolVersion: 1,
        type: 'surface.bootstrap',
        payload: { surface: 'floating', windowId: 900, instanceToken: 'floating-source' },
      }, POPUP_SENDER);
      const first = fake.dispatch({
        protocolVersion: 1,
        type: 'pip.returnToSidePanel',
        payload: {
          sessionId: 'pip-unidentified-target',
          hostWindowId: 900,
          ownerWindowId: 77,
          switchId: 'unbootstrapped-return',
        },
      }, floatHostSender(900));
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(first).resolves.toMatchObject({ reason: 'target-close-failed' });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(fake.sessionRecords[SURFACE_SWITCH_STORAGE_KEY]).toBeNull();
      expect(fake.sessionRecords[SURFACE_SWITCH_ABANDONED_TARGET_STORAGE_KEY]).toMatchObject({
        switchId: 'unbootstrapped-return',
        phase: 'target-unidentified',
      });
      expect(fake.sidePanelCloseCalls).toEqual([]);

      const retry = fake.dispatch({
        protocolVersion: 1,
        type: 'pip.returnToSidePanel',
        payload: {
          sessionId: 'pip-unidentified-target',
          hostWindowId: 900,
          ownerWindowId: 77,
          switchId: 'fresh-return',
        },
      }, floatHostSender(900));
      expect(fake.sidePanelOpenCalls).toEqual([77, 77]);
      await fake.dispatch({
        protocolVersion: 1,
        type: 'surface.bootstrap',
        payload: { surface: 'sidepanel', windowId: 77, instanceToken: 'old-late-panel' },
      }, POPUP_SENDER);
      await fake.dispatch({
        protocolVersion: 1,
        type: 'surface.ready',
        payload: {
          switchId: 'fresh-return',
          surface: 'sidepanel',
          eventWatermark: 0,
          windowId: 77,
          instanceToken: 'old-late-panel',
        },
      }, POPUP_SENDER);
      await expect(retry).resolves.toEqual({ ok: true, switchId: 'fresh-return' });
      expect(fake.sidePanelCloseCalls).toEqual([]);
      expect(fake.sessionRecords[SURFACE_SWITCH_ABANDONED_TARGET_STORAGE_KEY]).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a stale return token before opening the side panel', async () => {
    const fake = await startWorker();
    const host = await fake.dispatch(
      { protocolVersion: 1, type: 'float.open' },
      POPUP_SENDER,
    ) as { ok: true; windowId: number };
    fake.sessionRecords[FLOAT_OWNER_WINDOW_ID_SESSION_KEY] = 77;
    await fake.dispatch({
      protocolVersion: 1,
      type: 'pip.opened',
      payload: { sessionId: 'pip-live', hostWindowId: host.windowId },
    }, floatHostSender(host.windowId));

    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'pip.returnToSidePanel',
      payload: {
        sessionId: 'pip-old', hostWindowId: host.windowId, ownerWindowId: 77,
        switchId: 'switch-old',
      },
    }, floatHostSender(host.windowId))).resolves.toEqual({
      ok: false, switchId: 'switch-old', reason: 'stale-switch',
    });
    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'pip.returnToSidePanel',
      payload: {
        sessionId: 'pip-live', hostWindowId: host.windowId, ownerWindowId: 88,
        switchId: 'switch-wrong-owner',
      },
    }, floatHostSender(host.windowId))).resolves.toEqual({
      ok: false, switchId: 'switch-wrong-owner', reason: 'stale-switch',
    });
    expect(fake.sidePanelOpenCalls).toEqual([]);
  });

  it('hydrates a stored live PiP session during worker bootstrap without focusing it', async () => {
    const recover = vi.spyOn(FloatWindowManager.prototype, 'recoverStoredPipSession');
    const fake = await startWorker({
      initialFloatWindowId: 900,
      initialSession: {
        [FLOAT_WINDOW_ID_SESSION_KEY]: 900,
        [FLOAT_OWNER_WINDOW_ID_SESSION_KEY]: 77,
        [PIP_SESSION_STORAGE_KEY]: {
          sessionId: 'unconfirmed-after-restart',
          hostWindowId: 900,
          phase: 'ready',
        },
      },
    });

    expect(recover).toHaveBeenCalledOnce();
    expect(fake.sessionRecords[PIP_SESSION_STORAGE_KEY]).toMatchObject({
      sessionId: 'unconfirmed-after-restart',
    });
    expect(fake.navigationCalls).toEqual([]);
  });

  it('returns a live PiP to its original owner after the worker restarts', async () => {
    let crossedMicrotask = false;
    const observedAtOpen: Array<{ windowId: number; crossedMicrotask: boolean }> = [];
    const fake = await startWorker({
      onSidePanelOpen: (windowId) => observedAtOpen.push({ windowId, crossedMicrotask }),
    });
    await fake.dispatch({
      protocolVersion: 1,
      type: 'surface.bootstrap',
      payload: { surface: 'sidepanel', windowId: 77, instanceToken: 'panel-source' },
    }, POPUP_SENDER);
    const toFloating = fake.dispatch({
      protocolVersion: 1,
      type: 'surface.switch.request',
      payload: {
        switchId: 'switch-to-floating',
        source: 'sidepanel',
        target: 'floating',
        sourceWindowId: 77,
        instanceToken: 'panel-source',
      },
    }, POPUP_SENDER);
    await vi.waitFor(() => expect(fake.healthChanges).toContainEqual({
      protocolVersion: 1,
      type: 'surface.switch.started',
      payload: { switchId: 'switch-to-floating', target: 'floating' },
    }));
    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'surface.bootstrap',
      payload: {
        surface: 'floating', windowId: 900, instanceToken: 'switch-to-floating',
      },
    }, POPUP_SENDER)).resolves.toEqual({
      ok: true,
      transaction: expect.objectContaining({
        switchId: 'switch-to-floating',
        targetIdentity: { hostWindowId: 900, instanceToken: 'switch-to-floating' },
      }),
    });
    await fake.dispatch({
      protocolVersion: 1,
      type: 'surface.ready',
      payload: {
        switchId: 'switch-to-floating', surface: 'floating', eventWatermark: 1,
        windowId: 900, instanceToken: 'switch-to-floating',
      },
    }, POPUP_SENDER);
    await toFloating;
    await fake.dispatch({
      protocolVersion: 1,
      type: 'pip.opened',
      payload: { sessionId: 'pip-survived', hostWindowId: 900 },
    }, floatHostSender(900));
    await fake.dispatch({
      protocolVersion: 1,
      type: 'pip.ready',
      payload: { sessionId: 'pip-survived', hostWindowId: 900, eventWatermark: 1 },
    }, floatHostSender(900));

    fake.navigationCalls.splice(0);
    workerSetup?.();
    await new Promise((resolve) => setTimeout(resolve, 0));

    queueMicrotask(() => { crossedMicrotask = true; });
    const returned = fake.dispatch({
      protocolVersion: 1,
      type: 'pip.returnToSidePanel',
      payload: {
        sessionId: 'pip-survived',
        hostWindowId: 900,
        ownerWindowId: 77,
        switchId: 'switch-after-restart',
      },
    }, floatHostSender(900));

    expect(observedAtOpen).toEqual([{ windowId: 77, crossedMicrotask: false }]);
    expect(fake.navigationCalls).toEqual([]);
    await vi.waitFor(() => expect(fake.healthChanges).toContainEqual({
      protocolVersion: 1,
      type: 'surface.switch.started',
      payload: { switchId: 'switch-after-restart', target: 'sidepanel' },
    }));
    await fake.dispatch({
      protocolVersion: 1,
      type: 'surface.bootstrap',
      payload: { surface: 'sidepanel', windowId: 77, instanceToken: 'panel-returned' },
    }, POPUP_SENDER);
    await fake.dispatch({
      protocolVersion: 1,
      type: 'surface.ready',
      payload: {
        switchId: 'switch-after-restart', surface: 'sidepanel', eventWatermark: 2,
        windowId: 77, instanceToken: 'panel-returned',
      },
    }, POPUP_SENDER);
    await expect(returned).resolves.toEqual({ ok: true, switchId: 'switch-after-restart' });
  });

  it('keeps the original PiP return owner when other browser windows click the action', async () => {
    const fake = await startWorker();
    await fake.dispatch({
      protocolVersion: 1,
      type: 'surface.bootstrap',
      payload: { surface: 'sidepanel', windowId: 77, instanceToken: 'panel-cross-source' },
    }, POPUP_SENDER);
    const toFloating = fake.dispatch({
      protocolVersion: 1,
      type: 'surface.switch.request',
      payload: {
        switchId: 'switch-cross-window',
        source: 'sidepanel',
        target: 'floating',
        sourceWindowId: 77,
        instanceToken: 'panel-cross-source',
      },
    }, POPUP_SENDER);
    await vi.waitFor(() => expect(fake.healthChanges).toContainEqual({
      protocolVersion: 1,
      type: 'surface.switch.started',
      payload: { switchId: 'switch-cross-window', target: 'floating' },
    }));
    await fake.dispatch({
      protocolVersion: 1,
      type: 'surface.bootstrap',
      payload: { surface: 'floating', windowId: 900, instanceToken: 'switch-cross-window' },
    }, POPUP_SENDER);
    await fake.dispatch({
      protocolVersion: 1,
      type: 'surface.ready',
      payload: {
        switchId: 'switch-cross-window', surface: 'floating', eventWatermark: 1,
        windowId: 900, instanceToken: 'switch-cross-window',
      },
    }, POPUP_SENDER);
    await toFloating;
    await fake.dispatch({
      protocolVersion: 1,
      type: 'pip.opened',
      payload: { sessionId: 'pip-cross-window', hostWindowId: 900 },
    }, floatHostSender(900));
    await fake.dispatch({
      protocolVersion: 1,
      type: 'pip.ready',
      payload: { sessionId: 'pip-cross-window', hostWindowId: 900, eventWatermark: 1 },
    }, floatHostSender(900));

    fake.navigationCalls.splice(0);
    fake.clickAction(88);
    await vi.waitFor(() => expect(fake.navigationCalls).toContainEqual({
      action: 'focus',
      windowId: 900,
      update: { focused: true },
    }));
    expect(fake.sessionRecords[FLOAT_OWNER_WINDOW_ID_SESSION_KEY]).toBe(77);

    workerSetup?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.clickAction(99);
    await vi.waitFor(() => expect(fake.navigationCalls.filter((call) => (
      typeof call === 'object'
      && call !== null
      && 'action' in call
      && call.action === 'focus'
    ))).toHaveLength(2));
    expect(fake.sessionRecords[FLOAT_OWNER_WINDOW_ID_SESSION_KEY]).toBe(77);

    const returned = fake.dispatch({
      protocolVersion: 1,
      type: 'pip.returnToSidePanel',
      payload: {
        sessionId: 'pip-cross-window',
        hostWindowId: 900,
        ownerWindowId: 77,
        switchId: 'return-cross-window',
      },
    }, floatHostSender(900));
    expect(fake.sidePanelOpenCalls).toEqual([77]);
    await vi.waitFor(() => expect(fake.healthChanges).toContainEqual({
      protocolVersion: 1,
      type: 'surface.switch.started',
      payload: { switchId: 'return-cross-window', target: 'sidepanel' },
    }));
    await fake.dispatch({
      protocolVersion: 1,
      type: 'surface.bootstrap',
      payload: { surface: 'sidepanel', windowId: 77, instanceToken: 'panel-cross-return' },
    }, POPUP_SENDER);
    await fake.dispatch({
      protocolVersion: 1,
      type: 'surface.ready',
      payload: {
        switchId: 'return-cross-window', surface: 'sidepanel', eventWatermark: 2,
        windowId: 77, instanceToken: 'panel-cross-return',
      },
    }, POPUP_SENDER);
    await expect(returned).resolves.toEqual({ ok: true, switchId: 'return-cross-window' });
  });

  it('opens a trusted cold return synchronously while lifecycle hydration is blocked', async () => {
    let crossedMicrotask = false;
    const observedAtOpen: Array<{ windowId: number; crossedMicrotask: boolean }> = [];
    const fake = await startWorker({
      onSidePanelOpen: (windowId) => observedAtOpen.push({ windowId, crossedMicrotask }),
    });
    await fake.dispatch({
      protocolVersion: 1,
      type: 'surface.bootstrap',
      payload: { surface: 'sidepanel', windowId: 77, instanceToken: 'panel-cold-source' },
    }, POPUP_SENDER);
    const toFloating = fake.dispatch({
      protocolVersion: 1,
      type: 'surface.switch.request',
      payload: {
        switchId: 'switch-cold-setup',
        source: 'sidepanel',
        target: 'floating',
        sourceWindowId: 77,
        instanceToken: 'panel-cold-source',
      },
    }, POPUP_SENDER);
    await vi.waitFor(() => expect(fake.healthChanges).toContainEqual({
      protocolVersion: 1,
      type: 'surface.switch.started',
      payload: { switchId: 'switch-cold-setup', target: 'floating' },
    }));
    await fake.dispatch({
      protocolVersion: 1,
      type: 'surface.bootstrap',
      payload: { surface: 'floating', windowId: 900, instanceToken: 'switch-cold-setup' },
    }, POPUP_SENDER);
    await fake.dispatch({
      protocolVersion: 1,
      type: 'surface.ready',
      payload: {
        switchId: 'switch-cold-setup', surface: 'floating', eventWatermark: 1,
        windowId: 900, instanceToken: 'switch-cold-setup',
      },
    }, POPUP_SENDER);
    await toFloating;
    await fake.dispatch({
      protocolVersion: 1,
      type: 'pip.opened',
      payload: { sessionId: 'pip-cold', hostWindowId: 900 },
    }, floatHostSender(900));
    await fake.dispatch({
      protocolVersion: 1,
      type: 'pip.ready',
      payload: { sessionId: 'pip-cold', hostWindowId: 900, eventWatermark: 1 },
    }, floatHostSender(900));

    fake.blockLifecycleHydration();
    workerSetup?.();

    const returnMessage = {
      protocolVersion: 1,
      type: 'pip.returnToSidePanel',
      payload: {
        sessionId: 'pip-cold',
        hostWindowId: 900,
        ownerWindowId: 77,
        switchId: 'switch-cold-return',
      },
    };
    await expect(fake.dispatch(returnMessage, {
      ...floatHostSender(900),
      url: `chrome-extension://${EXTENSION_ID}/sidepanel.html`,
      tab: {
        ...floatHostSender(900).tab,
        url: `chrome-extension://${EXTENSION_ID}/sidepanel.html`,
      },
    })).resolves.toBeUndefined();
    await expect(fake.dispatch(returnMessage, floatHostSender(901))).resolves.toBeUndefined();
    expect(fake.sidePanelOpenCalls).toEqual([]);

    queueMicrotask(() => { crossedMicrotask = true; });
    const returned = fake.dispatch(returnMessage, floatHostSender(900));

    expect(observedAtOpen).toEqual([{ windowId: 77, crossedMicrotask: false }]);
    fake.releaseLifecycleHydration();
    await vi.waitFor(() => expect(fake.healthChanges).toContainEqual({
      protocolVersion: 1,
      type: 'surface.switch.started',
      payload: { switchId: 'switch-cold-return', target: 'sidepanel' },
    }));
    await fake.dispatch({
      protocolVersion: 1,
      type: 'surface.bootstrap',
      payload: { surface: 'sidepanel', windowId: 77, instanceToken: 'panel-cold-return' },
    }, POPUP_SENDER);
    await fake.dispatch({
      protocolVersion: 1,
      type: 'surface.ready',
      payload: {
        switchId: 'switch-cold-return', surface: 'sidepanel', eventWatermark: 2,
        windowId: 77, instanceToken: 'panel-cold-return',
      },
    }, POPUP_SENDER);
    await expect(returned).resolves.toEqual({ ok: true, switchId: 'switch-cold-return' });
  });

  it('binds a cold rejected pre-open before reconciling its detached cleanup', async () => {
    const fake = await startWorker({
      initialFloatWindowId: 900,
      initialSession: {
        [FLOAT_WINDOW_ID_SESSION_KEY]: 900,
        [FLOAT_OWNER_WINDOW_ID_SESSION_KEY]: 77,
        [PIP_SESSION_STORAGE_KEY]: {
          sessionId: 'pip-detached',
          hostWindowId: 900,
          phase: 'ready',
        },
      },
    });
    fake.sessionRecords[SURFACE_SWITCH_STORAGE_KEY] = {
      switchId: 'existing-completed-cleanup',
      source: 'floating',
      target: 'sidepanel',
      sourceWindowId: 66,
      targetIdentity: { hostWindowId: 66, instanceToken: 'old-panel' },
      phase: 'target-closed',
      startedAt: Date.now(),
    };
    fake.blockLifecycleHydration();
    workerSetup?.();

    const first = fake.dispatch({
      protocolVersion: 1,
      type: 'pip.returnToSidePanel',
      payload: {
        sessionId: 'pip-detached',
        hostWindowId: 900,
        ownerWindowId: 77,
        switchId: 'cold-rejected-pre-open',
      },
    }, floatHostSender(900));
    expect(fake.sidePanelOpenCalls).toEqual([77]);
    fake.releaseLifecycleHydration();

    await expect(first).resolves.toEqual({
      ok: false,
      switchId: 'cold-rejected-pre-open',
      reason: 'switch-in-progress',
    });
    expect(fake.sessionRecords[SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY]).toMatchObject({
      targetIdentity: { hostWindowId: 77 },
      phase: 'closing-target',
    });
    await fake.dispatch({
      protocolVersion: 1,
      type: 'surface.bootstrap',
      payload: { surface: 'sidepanel', windowId: 88, instanceToken: 'unrelated-panel' },
    }, POPUP_SENDER);
    expect(fake.sidePanelCloseCalls).toEqual([]);

    await fake.dispatch({
      protocolVersion: 1,
      type: 'surface.bootstrap',
      payload: { surface: 'sidepanel', windowId: 77, instanceToken: 'opened-panel' },
    }, POPUP_SENDER);
    expect(fake.sidePanelCloseCalls).toEqual([77]);
    expect(fake.sessionRecords[SURFACE_SWITCH_DETACHED_CLEANUP_STORAGE_KEY]).toBeNull();
    await vi.waitFor(() => expect(fake.sessionRecords[SURFACE_SWITCH_STORAGE_KEY]).toBeNull());

    const retry = fake.dispatch({
      protocolVersion: 1,
      type: 'pip.returnToSidePanel',
      payload: {
        sessionId: 'pip-detached',
        hostWindowId: 900,
        ownerWindowId: 77,
        switchId: 'after-detached-cleanup',
      },
    }, floatHostSender(900));
    expect(fake.sidePanelOpenCalls).toEqual([77, 77]);
    await fake.dispatch({
      protocolVersion: 1,
      type: 'surface.bootstrap',
      payload: { surface: 'sidepanel', windowId: 77, instanceToken: 'retry-panel' },
    }, POPUP_SENDER);
    await fake.dispatch({
      protocolVersion: 1,
      type: 'surface.ready',
      payload: {
        switchId: 'after-detached-cleanup',
        surface: 'sidepanel',
        eventWatermark: 0,
        windowId: 77,
        instanceToken: 'retry-panel',
      },
    }, POPUP_SENDER);
    await expect(retry).resolves.toEqual({ ok: true, switchId: 'after-detached-cleanup' });
  });

  it('restores a matching PiP close when return-to-sidepanel opening fails', async () => {
    const fake = await startWorker({ rejectSidePanelOpen: true });
    const host = await fake.dispatch(
      { protocolVersion: 1, type: 'float.open' },
      POPUP_SENDER,
    ) as { ok: true; windowId: number };
    fake.sessionRecords[FLOAT_OWNER_WINDOW_ID_SESSION_KEY] = 77;
    const sender = floatHostSender(host.windowId);
    await fake.dispatch({
      protocolVersion: 1,
      type: 'pip.opened',
      payload: { sessionId: 'pip-return-failed', hostWindowId: host.windowId },
    }, sender);
    await fake.dispatch({
      protocolVersion: 1,
      type: 'pip.ready',
      payload: {
        sessionId: 'pip-return-failed', hostWindowId: host.windowId, eventWatermark: 1,
      },
    }, sender);

    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'pip.returnToSidePanel',
      payload: {
        sessionId: 'pip-return-failed',
        hostWindowId: host.windowId,
        ownerWindowId: 77,
        switchId: 'switch-failed',
      },
    }, sender)).resolves.toEqual({
      ok: false,
      switchId: 'switch-failed',
      reason: 'target-open-failed',
    });
    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'pip.closed',
      payload: {
        sessionId: 'pip-return-failed',
        hostWindowId: host.windowId,
        reason: 'return-to-sidepanel',
      },
    }, sender)).resolves.toEqual({ ok: true, restored: true });
    expect(fake.navigationCalls.at(-1)).toEqual({
      action: 'focus',
      windowId: host.windowId,
      update: { state: 'normal', focused: true },
    });
  });

  it('persists bounds reported for the active floating window', async () => {
    const fake = await startWorker();
    const opened = await fake.dispatch(
      { protocolVersion: 1, type: 'float.open' },
      POPUP_SENDER,
    ) as { ok: boolean; windowId?: number };

    expect(opened).toMatchObject({ ok: true, windowId: 900 });
    fake.changeWindowBounds({
      id: 900,
      width: 520,
      height: 740,
      left: 35,
      top: 45,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fake.localRecords[FLOAT_GEOMETRY_STORAGE_KEY]).toEqual({
      width: 520,
      height: 740,
      left: 35,
      top: 45,
    });
  });

  it('keeps a translation session on the Fomo tab that created it', async () => {
    const deliveries: Array<{ tabId: number; command: string; sessionId?: string }> = [];
    const fake = await startWorker({
      fomoTabs: 2,
      activeFomoTabId: 0,
      onTabMessage(tabId, rawMessage) {
        const message = rawMessage as {
          type?: string;
          payload?: { command?: string; sessionId?: string };
        };
        if (message.type !== 'translation.request' || message.payload?.command === undefined) {
          return undefined;
        }
        deliveries.push({
          tabId,
          command: message.payload.command,
          ...(message.payload.sessionId === undefined
            ? {}
            : { sessionId: message.payload.sessionId }),
        });
        if (message.payload.command === 'create') {
          return { ok: true, result: { sessionId: `host-session-${tabId}` } };
        }
        if (message.payload.command === 'translate') {
          return message.payload.sessionId === `host-session-${tabId}`
            ? { ok: true, result: `translated-by-${tabId}` }
            : { ok: false, error: { code: 'context-disposed' } };
        }
        return { ok: true, result: null };
      },
    });

    const created = await fake.dispatch({
      protocolVersion: 1,
      type: 'translation.request',
      payload: {
        requestId: 'request-create',
        clientId: 'panel-1',
        command: 'create',
        sourceLanguage: 'en',
        targetLanguage: 'zh',
      },
    }, POPUP_SENDER) as { ok: true; result: { sessionId: string } };

    fake.setActiveFomoTab(1);
    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'translation.request',
      payload: {
        requestId: 'request-translate',
        clientId: 'panel-1',
        command: 'translate',
        sessionId: created.result.sessionId,
        text: 'English opinion',
      },
    }, POPUP_SENDER)).resolves.toEqual({ ok: true, result: 'translated-by-0' });

    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'translation.request',
      payload: {
        requestId: 'request-destroy',
        clientId: 'panel-1',
        command: 'destroy',
        sessionId: created.result.sessionId,
      },
    }, POPUP_SENDER)).resolves.toEqual({ ok: true, result: null });

    expect(deliveries).toEqual([
      { tabId: 0, command: 'create' },
      { tabId: 0, command: 'translate', sessionId: 'host-session-0' },
      { tabId: 0, command: 'destroy', sessionId: 'host-session-0' },
    ]);
  });

  it('never reroutes a disposed bound translation session to another Fomo tab', async () => {
    const deliveries: number[] = [];
    const fake = await startWorker({
      fomoTabs: 2,
      activeFomoTabId: 0,
      onTabMessage(tabId, rawMessage) {
        const message = rawMessage as { type?: string; payload?: { command?: string } };
        if (message.type !== 'translation.request') return undefined;
        deliveries.push(tabId);
        return message.payload?.command === 'create'
          ? { ok: true, result: { sessionId: 'en:zh' } }
          : { ok: true, result: 'unexpected fallback' };
      },
    });
    const created = await fake.dispatch({
      protocolVersion: 1,
      type: 'translation.request',
      payload: {
        requestId: 'request-create-disposed',
        clientId: 'panel-1',
        command: 'create',
        sourceLanguage: 'en',
        targetLanguage: 'zh',
      },
    }, POPUP_SENDER) as { ok: true; result: { sessionId: string } };

    fake.removeTab(0);
    fake.setActiveFomoTab(1);
    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'translation.request',
      payload: {
        requestId: 'request-translate-disposed',
        clientId: 'panel-1',
        command: 'translate',
        sessionId: created.result.sessionId,
        text: 'English opinion',
      },
    }, POPUP_SENDER)).resolves.toEqual({
      ok: false,
      error: { code: 'context-disposed' },
    });
    expect(deliveries).toEqual([0]);
  });

  it('accepts navigation only from the privileged UI sender', async () => {
    const fake = await startWorker({ fomoTabs: 1 });
    const message = {
      protocolVersion: 1,
      type: 'navigation.openToken',
      payload: { chain: 'bsc', tokenAddress: TOKEN_ADDRESS },
    };
    await expect(fake.dispatch(message, FOMO_TAB_SENDER)).resolves.toBeUndefined();
    expect(fake.navigationCalls).toEqual([]);
    await expect(fake.dispatch(message, POPUP_SENDER)).resolves.toEqual({ ok: true });
    expect(fake.navigationCalls).toContainEqual({
      action: 'update',
      tabId: 0,
      update: {
        url: `https://fomo.family/tokens/bnb/${TOKEN_ADDRESS}`,
        active: true,
      },
    });
  });
  it('rejects other-extension navigation before any tab API call', async () => {
    const fake = await startWorker({ fomoTabs: 1 });
    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'navigation.openToken',
      payload: { chain: 'bsc', tokenAddress: TOKEN_ADDRESS },
    }, { id: 'other-extension' })).resolves.toBeUndefined();
    expect(fake.navigationCalls).toEqual([]);
  });

  it('closes invalid token targets before querying tabs', async () => {
    const fake = await startWorker({ fomoTabs: 1 });
    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'navigation.openToken',
      payload: { chain: 'bsc', tokenAddress: 'not-an-address' },
    }, POPUP_SENDER)).resolves.toEqual({ ok: false, reason: 'invalid-target' });
    expect(fake.navigationCalls).toEqual([]);
  });

  it('records one closed redacted diagnostic when update and fallback create fail', async () => {
    const recordDiagnostic = vi.spyOn(DiagnosticRecorder.prototype, 'record');
    const fake = await startWorker({
      fomoTabs: 1,
      rejectTabUpdate: true,
      rejectTabCreate: true,
    });
    recordDiagnostic.mockClear();
    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'navigation.openToken',
      payload: { chain: 'bsc', tokenAddress: TOKEN_ADDRESS },
    }, POPUP_SENDER)).resolves.toEqual({ ok: false, reason: 'chrome-api-failed' });
    expect(recordDiagnostic).toHaveBeenCalledTimes(1);
    expect(recordDiagnostic).toHaveBeenCalledWith({
      code: 'token_navigation_failure',
      messageType: 'navigation.openToken',
    });
    expect(JSON.stringify(recordDiagnostic.mock.calls)).not.toContain(TOKEN_ADDRESS);
    expect(JSON.stringify(recordDiagnostic.mock.calls)).not.toContain('bsc');
    expect(JSON.stringify(recordDiagnostic.mock.calls)).not.toContain('sensitive');
    expect(JSON.stringify(recordDiagnostic.mock.calls)).not.toContain('https://');
  });
  it('delivers multiple observed frames through bridge and worker with redacted health', async () => {
    const dbName = 'boundary-' + crypto.randomUUID();
    vi.stubGlobal('__FOMO_TEST_DB_NAME__', dbName);
    const database = new FomoFeedDatabase(dbName);
    databases.push(database);
    const repository = new EventRepository(database);
    const fake = await startWorker({ fomoTabs: 1 });

    type Listener = (event?: unknown) => void;
    const windowListeners = new Map<string, Listener[]>();
    const socketListeners = new Map<string, Listener[]>();
    class FakeSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      constructor(url: string) { this.url = url; }
      addEventListener(type: 'message' | 'open' | 'close', listener: Listener): void {
        socketListeners.set(type, [...(socketListeners.get(type) ?? []), listener]);
      }
    }
    const win = {
      origin: 'https://fomo.family',
      WebSocket: FakeSocket as unknown as WebSocketConstructorLike,
      postMessage(message: unknown): void {
        for (const listener of windowListeners.get('message') ?? []) {
          listener({ source: win, data: message } satisfies WindowMessageEventLike);
        }
      },
      addEventListener(type: string, listener: Listener): void {
        windowListeners.set(type, [...(windowListeners.get(type) ?? []), listener]);
      },
      removeEventListener(type: string, listener: Listener): void {
        windowListeners.set(type, (windowListeners.get(type) ?? []).filter((item) => item !== listener));
      },
    };

    const bridge = installFomoBridge({
      window: win as unknown as BridgeWindowLike,
      sendMessage: (message) => fake.dispatch(message, FOMO_TAB_SENDER),
      now: () => NOW,
    });
    installFomoWebSocketObserver(win, () => NOW);
    new win.WebSocket('wss://prod-api.fomo.family/ws');

    const frames = Array.from({ length: 5 }, (_, index) => ({
      type: 'data',
      topicType: 'trading_activity',
      payload: {
        id: `activity-${index}`,
        tradeId: `trade-${index}`,
        type: 'swap_buy',
        userId: `trader-${index}`,
        userHandle: `trader${index}`,
        ticker: `TOK${index}`,
        tokenAddress: TOKEN_ADDRESS,
        networkId: 56,
        createdAt: new Date(NOW - (5 - index) * 1_000).toISOString(),
      },
    }));
    const messages = [...frames, frames[0]];
    for (const frame of messages) {
      for (const listener of socketListeners.get('message') ?? []) {
        listener({ data: JSON.stringify(frame) } satisfies MessageEventLike);
      }
    }

    await vi.waitFor(async () => expect(await repository.page({ limit: 20 })).toHaveLength(5));
    const { runtime } = createPopupRuntime(fake);
    await vi.waitFor(async () => {
      const { health } = await queryPipelineHealth(runtime);
      expect(health).toMatchObject({
        activityCandidates: 6,
        accepted: 6,
        rejected: 1,
        duplicates: 1,
        persisted: 5,
        broadcasts: 5,
        latestEventOccurredAt: NOW - 1_000,
      });
      expect(JSON.stringify(health)).not.toContain(TOKEN_ADDRESS);
      expect(JSON.stringify(health)).not.toContain('trader0');
    });
    expect(fake.broadcasts).toHaveLength(5);
    await vi.waitFor(() => expect(fake.healthChanges.filter((message) =>
      (message as { type?: unknown }).type === 'pipeline.healthChanged')).toHaveLength(1));
    expect(fake.healthChanges.filter((message) =>
      (message as { type?: unknown }).type === 'events.changed')).toEqual(
        Array.from({ length: 5 }, () => ({ protocolVersion: 1, type: 'events.changed' })),
      );
    expect(JSON.stringify(fake.healthChanges)).not.toContain(TOKEN_ADDRESS);

    for (const listener of socketListeners.get('message') ?? []) {
      listener({ data: JSON.stringify({
        type: 'data',
        topicType: 'trading_activity',
        payload: { tokenAddress: 'secret-payload' },
      }) } satisfies MessageEventLike);
    }
    await vi.waitFor(async () => {
      const { health } = await queryPipelineHealth(runtime);
      expect(health.rejected).toBe(2);
      expect(health.lastRejectionCode).toBe('schema_invalid');
      expect(await repository.page({ limit: 20 })).toHaveLength(5);
      expect(JSON.stringify(health)).not.toContain('secret-payload');
    });
    bridge.uninstall();
  });
  it('continues bootstrap and records a diagnostic when side panel setup rejects', async () => {
    const recordDiagnostic = vi.spyOn(DiagnosticRecorder.prototype, 'record');

    const fake = await startWorker({ rejectSidePanelSetup: true });

    await vi.waitFor(() => {
      expect(fake.badgeCalls.length).toBeGreaterThan(0);
    });
    expect(recordDiagnostic).toHaveBeenCalledWith({
      code: 'storage_failure',
      messageType: 'sidepanel.bootstrap',
    });
  });

  it('bootstrap reclassifies stored unknown rows with verified networkIds and is idempotent', async () => {
    const dbName = 'boundary-' + crypto.randomUUID();
    vi.stubGlobal('__FOMO_TEST_DB_NAME__', dbName);

    const database = new FomoFeedDatabase(dbName);
    databases.push(database);

    const repository = new EventRepository(database);

    await repository.insert({
      ...makeEvent(),
      id: 'fomo:unknown-56',
      chain: 'unknown',
      networkId: 56,
      tokenAddress: TOKEN_ADDRESS,
      occurredAt: NOW - 120_000,
    });

    await startWorker();

    // Bootstrap is async and may take more than one microtask; poll until the
    // reclassification lands or the test timeout fires.
    await vi.waitFor(async () => {
      const reclassified = await repository.get('fomo:unknown-56');
      expect(reclassified?.chain).toBe('bsc');
    });

    const reclassified = await repository.get('fomo:unknown-56');
    expect(reclassified?.networkId).toBe(56);
    expect(reclassified?.tokenAddress).toBe(TOKEN_ADDRESS);
    expect(reclassified?.readAt).toBeUndefined();

    // Idempotency: a second bootstrap leaves the already-reclassified row
    // untouched.
    await startWorker();

    const stillReclassified = await repository.get('fomo:unknown-56');
    expect(stillReclassified?.chain).toBe('bsc');
  });

  it('queryConnection answers offline + no Fomo tab on a cold worker', async () => {
    const fake = await startWorker();
    const { runtime } = createPopupRuntime(fake);

    const connection = await queryConnection(runtime);

    expect(connection).toEqual({
      ok: true,
      connected: false,
      authenticated: false,
      hasFomoTab: false,
    });
  });

  it('queryConnection reports an open authenticated socket as connected (BLOCKING 2 steady state)', async () => {
    const fake = await startWorker({ fomoTabs: 1 });
    const { runtime } = createPopupRuntime(fake);

    // The bridge reports the authenticated socket OPEN once...
    await fake.dispatch(
      {
        protocolVersion: 1,
        type: 'connection.changed',
        payload: { connected: true, authenticated: true, at: NOW },
      },
      FOMO_TAB_SENDER,
    );

    // ...then NOTHING for ten minutes (idle socket, no activity). The popup
    // must still read connected - never login-required, never offline.
    const connection = await queryConnection(runtime);

    expect(connection).toEqual({
      ok: true,
      connected: true,
      authenticated: true,
      hasFomoTab: true,
    });
    expect(popupConnectionState(connection)).toBe('connected');

    // And the badge refresh (socket close is the only disconnect signal; an
    // idle socket must stay purple) - the worker never re-derives it from
    // activity age.
    expect(
      fake.sessionRecords['connectionState.v1'],
    ).toBeDefined();
  });

  it('drops connected state when the owning Fomo tab is closed', async () => {
    const fake = await startWorker({ fomoTabs: 1 });
    const { runtime } = createPopupRuntime(fake);

    await fake.dispatch(
      {
        protocolVersion: 1,
        type: 'connection.changed',
        payload: { connected: true, authenticated: true, at: NOW },
      },
      FOMO_TAB_SENDER,
    );

    fake.removeTab(0);

    await vi.waitFor(async () => {
      const connection = await queryConnection(runtime);
      expect(connection.connected).toBe(false);
      expect(connection.authenticated).toBe(false);
    });
  });

  it('clears Pump session state when the tracked tab navigates away', async () => {
    const fake = await startWorker({
      pumpTabs: 1,
      initialSession: {
        'pump.session.v1': {
          watermark: '1399811149:old-transaction',
          recentKeys: ['1399811149:old-transaction'],
        },
        'pump.status.v1': {
          epoch: 1,
          status: 'live',
          at: NOW,
          backoffLevel: 0,
        },
      },
    });

    await expect(fake.dispatch({
      protocolVersion: 1,
      type: 'pump.lease.request',
      payload: { at: NOW },
    }, PUMP_TAB_SENDER)).resolves.toMatchObject({ ok: true, granted: true });

    fake.updateTabUrl(100, 'https://example.com/');

    await vi.waitFor(() => {
      expect(fake.sessionRecords['pump.session.v1']).toBeNull();
      expect(fake.sessionRecords['pump.status.v1']).toBeNull();
    });
  });

  it('drops connected state when the owning tab navigates away from Fomo', async () => {
    const fake = await startWorker({ fomoTabs: 1 });
    const { runtime } = createPopupRuntime(fake);

    await fake.dispatch(
      {
        protocolVersion: 1,
        type: 'connection.changed',
        payload: { connected: true, authenticated: true, at: NOW },
      },
      FOMO_TAB_SENDER,
    );

    fake.updateTabUrl(0, 'https://example.com/');

    await vi.waitFor(async () => {
      const connection = await queryConnection(runtime);
      expect(connection.connected).toBe(false);
      expect(connection.authenticated).toBe(false);
    });
  });

  it('drops a tracked connection when navigation starts without exposing the destination URL', async () => {
    const fake = await startWorker({ fomoTabs: 1 });
    const { runtime } = createPopupRuntime(fake);
    await fake.dispatch({
      protocolVersion: 1,
      type: 'connection.changed',
      payload: { connected: true, authenticated: true, at: NOW },
    }, FOMO_TAB_SENDER);

    fake.startTabNavigation(0);

    await vi.waitFor(async () => {
      expect((await queryConnection(runtime)).connected).toBe(false);
    });
  });

  it('ignores lifecycle events from tabs that never owned a Fomo connection', async () => {
    const fake = await startWorker({ fomoTabs: 1 });
    await fake.dispatch({
      protocolVersion: 1,
      type: 'connection.changed',
      payload: { connected: true, authenticated: true, at: NOW },
    }, FOMO_TAB_SENDER);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const connectionBroadcastsBefore = fake.healthChanges.filter((message) =>
      (message as { type?: string }).type === 'connection.changed').length;

    fake.removeTab(99);

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.healthChanges.filter((message) =>
      (message as { type?: string }).type === 'connection.changed')).toHaveLength(
      connectionBroadcastsBefore,
    );
  });

  it('queryConnection reports login-required when a Fomo tab exists but no socket ever opened', async () => {
    const fake = await startWorker({ fomoTabs: 1 });
    const { runtime } = createPopupRuntime(fake);

    const connection = await queryConnection(runtime);

    expect(connection).toEqual({
      ok: true,
      connected: false,
      authenticated: false,
      hasFomoTab: true,
    });
    expect(popupConnectionState(connection)).toBe('login-required');
  });

  it('queryConnection reports reconnecting when authenticated but the socket closed', async () => {
    const fake = await startWorker({ fomoTabs: 1 });
    const { runtime } = createPopupRuntime(fake);

    await fake.dispatch(
      {
        protocolVersion: 1,
        type: 'connection.changed',
        payload: { connected: true, authenticated: true, at: NOW },
      },
      FOMO_TAB_SENDER,
    );
    await fake.dispatch(
      {
        protocolVersion: 1,
        type: 'connection.changed',
        payload: { connected: false, authenticated: true, at: NOW + 1_000 },
      },
      FOMO_TAB_SENDER,
    );

    const connection = await queryConnection(runtime);

    expect(connection).toEqual({
      ok: true,
      connected: false,
      authenticated: true,
      hasFomoTab: true,
    });
    expect(popupConnectionState(connection)).toBe('reconnecting');
  });

  it('queryEvents serves the real repository rows through the real listener', async () => {
    const dbName = 'boundary-' + crypto.randomUUID();
    vi.stubGlobal('__FOMO_TEST_DB_NAME__', dbName);

    const database = new FomoFeedDatabase(dbName);
    databases.push(database);

    const repository = new EventRepository(database);

    await repository.insert(makeEvent());

    const fake = await startWorker();
    const { runtime } = createPopupRuntime(fake);

    const events = await queryEvents(runtime, { limit: 50 });

    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe('fomo:event-1');
    expect(events[0]?.tokenAddress).toBe(TOKEN_ADDRESS);
  });

  it('drops a malformed row instead of crashing and records a bounded diagnostic (BLOCKING 3)', async () => {
    const dbName = 'boundary-' + crypto.randomUUID();
    vi.stubGlobal('__FOMO_TEST_DB_NAME__', dbName);

    const database = new FomoFeedDatabase(dbName);
    databases.push(database);

    const repository = new EventRepository(database);

    await repository.insert(makeEvent());
    // Simulate DB corruption / a future schema v2 row living next to valid
    // rows: only the valid row may reach the popup UI.
    // A future-schema-v2 row with a valid occurredAt (so the occurredAt
    // index returns it): the popup must drop it without crashing.
    await database.events.add({
      id: 'fomo:malformed',
      schemaVersion: 2,
      source: 'fomo',
      occurredAt: NOW - 10_000,
    } as unknown as TradeEventV1);

    const fake = await startWorker();
    const { runtime, sent } = createPopupRuntime(fake);

    const events = await queryEvents(runtime, { limit: 50 });

    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe('fomo:event-1');

    // The popup asked the worker to record ONE bounded, redacted
    // schema-rejection diagnostic for the affected query.
    const diagnostic = sent.find(
      (message) =>
        typeof message === 'object' &&
        message !== null &&
        (message as { type?: unknown }).type === 'diagnostics.record',
    );

    expect(diagnostic).toBeDefined();
    expect(diagnostic).toMatchObject({
      protocolVersion: 1,
      type: 'diagnostics.record',
      payload: { code: 'schema_rejection', messageType: 'events.query' },
    });
  });

  it('markEventsRead marks rows and refreshes the badge; a rejected send resolves false', async () => {
    const dbName = 'boundary-' + crypto.randomUUID();
    vi.stubGlobal('__FOMO_TEST_DB_NAME__', dbName);

    const database = new FomoFeedDatabase(dbName);
    databases.push(database);

    const repository = new EventRepository(database);

    await repository.insert(makeEvent());
    await repository.insert(
      makeEvent({ id: 'fomo:event-2', occurredAt: NOW - 2000 }),
    );

    const fake = await startWorker();
    const { runtime } = createPopupRuntime(fake);

    const succeeded = await markEventsRead(runtime, ['fomo:event-1'], NOW);

    expect(succeeded).toBe(true);
    expect((await repository.get('fomo:event-1'))?.readAt).toBe(NOW);
    expect((await repository.get('fomo:event-2'))?.readAt).toBeUndefined();

    // Badge was refreshed after the mark (the remaining unread event-2 keeps
    // the badge at 1).
    expect(fake.badgeCalls.some((call) => call.text === '1')).toBe(true);

    // A rejected runtime send resolves false so the popup never lies locally.
    const deadRuntime: PopupRuntimeLike = {
      async sendMessage(): Promise<unknown> {
        throw new Error('worker suspended');
      },
      onMessage: {
        addListener(): void {},
        removeListener(): void {},
      },
    };

    await expect(markEventsRead(deadRuntime, ['fomo:event-2'], NOW)).resolves.toBe(false);
  });

  it('rejects a popup-originated query from a Fomo tab sender', async () => {
    const fake = await startWorker();

    const response = await fake.dispatch(
      {
        protocolVersion: 1,
        type: 'events.query',
        payload: { limit: 50 },
      },
      FOMO_TAB_SENDER,
    );

    expect(response).toBeUndefined();
  });

  it('keeps trader metrics unavailable in the real worker until the evidence gate passes (Task 8)', async () => {
    const dbName = 'boundary-' + crypto.randomUUID();
    vi.stubGlobal('__FOMO_TEST_DB_NAME__', dbName);

    const database = new FomoFeedDatabase(dbName);
    databases.push(database);

    const repository = new EventRepository(database);

    // One Fomo tab so the overlay broadcast is actually delivered.
    const fake = await startWorker({ fomoTabs: 1 });

    await fake.dispatch(
      {
        protocolVersion: 1,
        type: 'activity.ingest',
        payload: {
          type: 'swap_buy',
          id: 'activity-1',
          tradeId: 'trade-1',
          userId: 'trader-1',
          userHandle: 'alpha',
          ticker: 'TKN',
          tokenAddress: TOKEN_ADDRESS,
          networkId: 56,
          createdAt: new Date(NOW - 60_000).toISOString(),
        },
      },
      FOMO_TAB_SENDER,
    );

    await vi.waitFor(async () => {
      expect(await repository.page({ limit: 20 })).toHaveLength(1);
    });

    // The worker wires unavailableMetricSource (see the evidence-gate comment
    // in entrypoints/background.ts): enrichment resolves to null immediately,
    // the negative cache record lands, and the stored event is never updated
    // with a metricSnapshot. Base activity still persists and broadcasts.
    await vi.waitFor(() => {
      expect(fake.broadcasts).toHaveLength(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const event = (await repository.page({ limit: 20 }))[0];

    expect(event?.id).toBe('fomo:activity-1');
    expect(event?.metricSnapshot).toBeUndefined();
  });

  it('accepts sync.request from a trusted popup and reports the disabled history path (Task 4)', async () => {
    const dbName = 'boundary-' + crypto.randomUUID();
    vi.stubGlobal('__FOMO_TEST_DB_NAME__', dbName);

    const database = new FomoFeedDatabase(dbName);
    databases.push(database);

    const repository = new EventRepository(database);

    const fake = await startWorker();

    // A manual refresh from the popup is accepted and routed to the recovery
    // coordinator. The production history client is the DISABLED
    // implementation (evidence gate in entrypoints/background.ts), so the run
    // fails and the state becomes 'recovery-unavailable'.
    await fake.dispatch(
      { protocolVersion: 1, type: 'sync.request', payload: { reason: 'manual' } },
      POPUP_SENDER,
    );

    // The single-flight run settles asynchronously; poll the sync.query until
    // the disabled client's state is visible.
    await vi.waitFor(async () => {
      const response = await fake.dispatch(
        { protocolVersion: 1, type: 'sync.query' },
        POPUP_SENDER,
      );

      expect(response).toMatchObject({
        ok: true,
        state: { status: 'recovery-unavailable' },
      });
    });

    expect(await repository.page({ limit: 50 })).toHaveLength(0);

    // The worker emitted the payload-less sync.changed notification on every
    // state transition (idle -> syncing -> recovery-unavailable).
    expect(fake.healthChanges.filter((message) =>
      (message as { type?: unknown }).type === 'sync.changed')).toHaveLength(2);
    expect(fake.healthChanges.every((message) =>
      (message as { type?: unknown }).type !== 'sync.changed' ||
      (message as { type?: unknown; payload?: unknown }).payload === undefined,
    )).toBe(true);

    // sync.request from a Fomo tab sender is rejected by the trust boundary.
    const rejected = await fake.dispatch(
      { protocolVersion: 1, type: 'sync.request', payload: { reason: 'manual' } },
      FOMO_TAB_SENDER,
    );

    expect(rejected).toBeUndefined();
  });

  it('queryActivitySync and requestActivitySync drive the real recovery path (Task 5)', async () => {
    const fake = await startWorker();
    const { runtime } = createPopupRuntime(fake);

    // A cold worker has not run recovery yet: the coordinator reports idle.
    expect(await queryActivitySync(runtime)).toEqual({ status: 'idle' });

    // A manual request is routed through the popup client into the
    // single-flight coordinator. The disabled history adapter settles the run
    // on 'recovery-unavailable', and the immediate follow-up query already
    // reflects that (or, at worst, the synchronous 'syncing' transition).
    const state = await requestActivitySync(runtime, 'manual');
    expect(['syncing', 'recovery-unavailable']).toContain(state.status);

    await vi.waitFor(async () => {
      expect(await queryActivitySync(runtime)).toEqual({ status: 'recovery-unavailable' });
    });

    // The worker emitted the payload-less sync.changed on every transition
    // (idle -> syncing -> recovery-unavailable), never a payload.
    expect(fake.healthChanges.filter((message) =>
      (message as { type?: unknown }).type === 'sync.changed')).toHaveLength(2);
    expect(fake.healthChanges.every((message) =>
      (message as { type?: unknown }).type !== 'sync.changed' ||
      (message as { type?: unknown; payload?: unknown }).payload === undefined,
    )).toBe(true);
  });
});
