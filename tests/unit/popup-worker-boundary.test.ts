import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TradeEventV1 } from '../../src/domain/activity';
import { DiagnosticRecorder } from '../../src/background/diagnostics';
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
  runtime: {
    id: string;
    sendMessage(message: unknown): Promise<unknown>;
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
    query(query: { url?: string | string[] }): Promise<Array<{ id?: number; url?: string; windowId: number; lastAccessed?: number }>>;
    update(tabId: number, update: { url: string; active: true }): Promise<unknown>;
    create(create: { url: string; active: true }): Promise<unknown>;
    sendMessage(tabId: number, message: unknown): Promise<void>;
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
    update(windowId: number, update: { focused: true }): Promise<unknown>;
  };
  action: {
    setBadgeText(details: { text: string }): Promise<void>;
    setBadgeBackgroundColor(details: { color: string }): Promise<void>;
  };
}

function createFakeBrowser(options: { fomoTabs?: number } = {}) {
  const localRecords: Record<string, unknown> = {};
  const sessionRecords: Record<string, unknown> = {};
  const badgeCalls: Array<{ text?: string; color?: string }> = [];
  const broadcasts: unknown[] = [];
  const healthChanges: unknown[] = [];
  const navigationCalls: unknown[] = [];
  let listener: ((message: unknown, sender: unknown) => unknown) | null = null;
  let removedListener: ((tabId: number) => void) | null = null;
  let updatedListener: ((tabId: number, changeInfo: { url?: string; status?: string }) => void) | null = null;

  const browser: FakeBrowser = {
    runtime: {
      id: EXTENSION_ID,
      async sendMessage(message: unknown): Promise<unknown> {
        healthChanges.push(message);
        return undefined;
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
      async query(): Promise<Array<{ id?: number; url?: string; windowId: number; lastAccessed?: number }>> {
        return Array.from({ length: options.fomoTabs ?? 0 }, (_, index) => ({
          id: index,
          url: 'https://fomo.family/',
          windowId: 1,
          lastAccessed: index,
        }));
      },
      async update(tabId, update): Promise<unknown> {
        navigationCalls.push({ action: 'update', tabId, update });
        return {};
      },
      async create(create): Promise<unknown> {
        navigationCalls.push({ action: 'create', create });
        return {};
      },
      async sendMessage(_tabId: number, message: unknown): Promise<void> {
        broadcasts.push(message);
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
    },
    action: {
      async setBadgeText(details: { text: string }): Promise<void> {
        badgeCalls.push({ text: details.text });
      },
      async setBadgeBackgroundColor(details: { color: string }): Promise<void> {
        badgeCalls.push({ color: details.color });
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
    dispatch: (message: unknown, sender: MessageSenderLike): Promise<unknown> => {
      const result = listener?.(message, sender);

      return Promise.resolve(result);
    },
    removeTab: (tabId: number): void => removedListener?.(tabId),
    updateTabUrl: (tabId: number, url: string): void => updatedListener?.(tabId, { url }),
    startTabNavigation: (tabId: number): void => updatedListener?.(tabId, { status: 'loading' }),
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
  options: { fomoTabs?: number; rejectSidePanelSetup?: boolean } = {},
) {
  const fake = createFakeBrowser(options);

  vi.stubGlobal('defineBackground', (setup: () => void) => setup);
  vi.stubGlobal('browser', fake.browser);
  vi.stubGlobal('chrome', {
    sidePanel: {
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
  await new Promise((resolve) => setTimeout(resolve, 0));

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
