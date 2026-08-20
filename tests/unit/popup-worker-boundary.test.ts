import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TradeEventV1 } from '../../src/domain/activity';
import { DiagnosticRecorder } from '../../src/background/diagnostics';
import type { MessageSenderLike } from '../../src/messaging/guards';
import { popupConnectionState } from '../../src/popup/event-query';
import {
  markEventsRead,
  queryConnection,
  queryEvents,
  type PopupRuntimeLike,
} from '../../src/popup/popup-io';
import { FomoFeedDatabase } from '../../src/storage/database';
import { EventRepository } from '../../src/storage/event-repository';

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
    query(query: { url?: string | string[] }): Promise<Array<{ id?: number; url?: string }>>;
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
  let listener: ((message: unknown, sender: unknown) => unknown) | null = null;

  const browser: FakeBrowser = {
    runtime: {
      id: EXTENSION_ID,
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
      async query(): Promise<Array<{ id?: number; url?: string }>> {
        return Array.from({ length: options.fomoTabs ?? 0 }, (_, index) => ({
          id: index,
          url: 'https://fomo.family/',
        }));
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
    dispatch: (message: unknown, sender: MessageSenderLike): Promise<unknown> => {
      const result = listener?.(message, sender);

      return Promise.resolve(result);
    },
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
});
