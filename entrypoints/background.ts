import type { TradeEventV1 } from '../src/domain/activity';
import type { BrowserActionLike } from '../src/background/badge';
import { refreshBadge as refreshBadgeFromStorage } from '../src/background/badge-refresh';
import {
  ConnectionStateMachine,
  readConnectionState,
  writeConnectionState,
  type SessionStorageLike,
} from '../src/background/connection-state';
import { DiagnosticRecorder } from '../src/background/diagnostics';
import {
  PersistedPipelineHealth,
} from '../src/background/pipeline-health';
import {
  ActivityIngestor,
  createRejectionCounter,
  type BroadcastActivityMessage,
} from '../src/background/ingest-activity';
import { ActivitySync } from '../src/background/activity-sync';
import { runRetention } from '../src/background/retention';
import { RetentionScheduler } from '../src/background/retention-schedule';
import {
  CachedTraderMetricSource,
  unavailableMetricSource,
} from '../src/fomo/enrichment-client';
import { unavailableHistoryClient } from '../src/fomo/history-client';
import { NETWORK_CATALOG } from '../src/fomo/network-map';
import {
  FOMO_ORIGINS,
  PUMP_ORIGINS,
  isTrustedFloatHostSender,
  isTrustedSenderForMessage,
  type MessageSenderLike,
} from '../src/messaging/guards';
import {
  parseExtensionMessage,
  type ExtensionMessage,
  type ConnectionQueryResponse,
  type EventQuery,
  type PipelineHealthQueryResponse,
  type SyncQueryResponse,
} from '../src/messaging/protocol';
import { createRuntimeMessageDispatcher } from '../src/messaging/runtime-dispatcher';
import {
  SurfaceSwitchCoordinator,
  type SurfaceSwitchResult,
} from '../src/background/surface-switch-coordinator';
import {
  CaptureRecovery,
  type CaptureRecoveryTabs,
} from '../src/background/capture-recovery';
import { FomoFeedDatabase } from '../src/storage/database';
import {
  EventRepository,
  reclassifyUnknownChainEvents,
  type EventPageQuery,
} from '../src/storage/event-repository';
import {
  LocalPreferences,
  type LocalPreferencesStorage,
} from '../src/storage/local-preferences';
import type { TraderAnnotationUpdate } from '../src/domain/annotations';
import type { LocalSettingsUpdate } from '../src/domain/settings';
import { PreferenceMutationCoordinator } from '../src/background/preference-mutations';
import {
  applyDisplayModeToAction,
  closeSidePanelForWindow,
  configureActionSidePanel,
  openSidePanelForWindow,
  type ChromeWithOptionalSidePanel,
} from '../src/sidepanel/sidepanel-api';
import { MetricRepository } from '../src/storage/metric-repository';
import { createLiveBuyNotifier } from '../src/background/buy-sound';
import {
  createOffscreenBuyAudioPlayer,
  type OffscreenAudioChrome,
} from '../src/background/offscreen-audio';
import {
  FloatWindowManager,
  type FloatWindowChrome,
  type FloatWindowGeometry,
} from '../src/background/float-window';
import {
  openActivityToken,
  type TokenNavigationChrome,
} from '../src/background/fomo-tab-navigation';
import { PumpLeaderCoordinator } from '../src/background/pump-leader';
import {
  parsePumpSessionState,
  parsePumpStatusSnapshot,
} from '../src/background/pump-session-store';
import {
  createPumpGapState,
  parsePumpGapState,
  PUMP_GAP_STORAGE_KEY,
} from '../src/background/pump-gap-store';
import { normalizePumpTrade } from '../src/pump/normalize';
import { parsePumpTradePage } from '../src/pump/raw-schema';

/**
 * Service-worker composition root (design spec section 4.3).
 *
 * The root is deliberately thin: every behavior lives in injectable modules
 * (ingest-activity, connection-state, badge-refresh, enrichment-client,
 * retention-schedule) so the worker never depends on in-memory state for
 * correctness — Manifest V3 may suspend it at any time. This module only
 * wires singletons, validates senders, routes messages by discriminant, and
 * applies the badge. Every detached async call is guarded with a catch that
 * records a storage_failure diagnostic, so an IndexedDB or storage failure
 * can never become an unhandled rejection in the service worker.
 */

const METRIC_TTL_MS = 5 * 60 * 1_000;
const METRIC_FAILURE_BACKOFF_MS = 60 * 1_000;
const PIPELINE_HEALTH_NOTIFICATION_DELAY_MS = 50;
const SIDE_PANEL_INSTANCE_TOKENS_SESSION_KEY = 'surfaceSwitch.sidePanelInstances.v1';

// Fomo tab patterns for the popup connection.query verdict (plan Task 9
// Step 3): derived from the SINGLE shared origin catalog in guards.ts
// (SHOULD-FIX 9) so hosts are declared in exactly one place.
const FOMO_TAB_URL_PATTERNS: string[] = FOMO_ORIGINS.map(
  (origin) => origin + '/*',
);
const PUMP_TAB_URL_PATTERNS: string[] = PUMP_ORIGINS.map(
  (origin) => origin + '/*',
);

/** Response shape consumed by the popup for events.query (plan Task 9). */
interface EventsQueryResponse {
  ok: true;
  events: TradeEventV1[];
}

/** Response shape consumed by the popup for events.markRead (plan Task 9). */
interface MarkReadResponse {
  ok: true;
  marked: number;
}

type TranslationRequestMessage = Extract<
  ExtensionMessage,
  { type: 'translation.request' }
>;

const TRANSLATION_SESSION_ROUTE_PREFIX = 'fomo-tab:';
const MAX_TRANSLATION_SESSION_ID_LENGTH = 128;

/**
 * Keep the content-script tab inside the opaque session id returned to the UI.
 * Unlike an in-memory map, this affinity survives Manifest V3 worker restarts.
 */
const bindTranslationSessionToTab = (
  tabId: number,
  hostSessionId: string,
): string | undefined => {
  const sessionId = `${TRANSLATION_SESSION_ROUTE_PREFIX}${tabId}:${hostSessionId}`;
  return sessionId.length <= MAX_TRANSLATION_SESSION_ID_LENGTH ? sessionId : undefined;
};

const readTranslationSessionRoute = (
  sessionId: string,
): { tabId: number; hostSessionId: string } | undefined => {
  if (!sessionId.startsWith(TRANSLATION_SESSION_ROUTE_PREFIX)) return undefined;
  const separator = sessionId.indexOf(':', TRANSLATION_SESSION_ROUTE_PREFIX.length);
  if (separator < 0) return undefined;
  const rawTabId = sessionId.slice(TRANSLATION_SESSION_ROUTE_PREFIX.length, separator);
  const hostSessionId = sessionId.slice(separator + 1);
  if (!/^\d+$/u.test(rawTabId) || hostSessionId.length === 0) return undefined;
  const tabId = Number(rawTabId);
  return Number.isSafeInteger(tabId) ? { tabId, hostSessionId } : undefined;
};

const translationSessionRoute = (
  message: TranslationRequestMessage,
): { tabId: number; hostSessionId: string } | undefined => {
  const command = message.payload;
  return command.command === 'translate' || command.command === 'destroy'
    ? readTranslationSessionRoute(command.sessionId)
    : undefined;
};

const forwardTranslationMessage = (
  message: TranslationRequestMessage,
  hostSessionId: string | undefined,
): TranslationRequestMessage => {
  if (hostSessionId === undefined) return message;
  const command = message.payload;
  if (command.command !== 'translate' && command.command !== 'destroy') return message;
  return {
    ...message,
    payload: { ...command, sessionId: hostSessionId },
  };
};

const bindTranslationCreateReply = (
  reply: unknown,
  tabId: number,
): unknown => {
  if (typeof reply !== 'object' || reply === null) return reply;
  const candidate = reply as { ok?: unknown; result?: unknown };
  if (candidate.ok !== true || typeof candidate.result !== 'object' || candidate.result === null) {
    return reply;
  }
  const sessionId = (candidate.result as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== 'string') return reply;
  const boundSessionId = bindTranslationSessionToTab(tabId, sessionId);
  if (boundSessionId === undefined) {
    return { ok: false, error: { code: 'translation-failed' } };
  }
  return { ok: true, result: { sessionId: boundSessionId } };
};

// chrome.runtime.MessageSender is not assignable to the guard's minimal
// MessageSenderLike under exactOptionalPropertyTypes (its Tab.url is typed
// string | undefined), so the listener adapts the sender before validation.
interface SenderForGuard {
  id?: string | undefined;
  url?: string | undefined;
  tab?: {
    url?: string | undefined;
    id?: number | undefined;
    windowId?: number | undefined;
  };
}

const toSenderLike = (sender: SenderForGuard): MessageSenderLike => ({
  ...(sender.id !== undefined ? { id: sender.id } : {}),
  ...(sender.url !== undefined ? { url: sender.url } : {}),
  ...(sender.tab === undefined ? {} : {
    tab: {
      ...(sender.tab.url === undefined ? {} : { url: sender.tab.url }),
      ...(sender.tab.id === undefined ? {} : { id: sender.tab.id }),
      ...(sender.tab.windowId === undefined ? {} : { windowId: sender.tab.windowId }),
    },
  }),
});

export default defineBackground(() => {
  // Test seam: the boundary test gives each test its OWN database name so
  // fake-indexeddb state can never leak between tests. Production never
  // defines the global, so the default name is used.
  const testDbName = (
    globalThis as { __FOMO_TEST_DB_NAME__?: string }
  ).__FOMO_TEST_DB_NAME__;
  const database = new FomoFeedDatabase(testDbName ?? undefined);
  const eventRepository = new EventRepository(database);
  const metricRepository = new MetricRepository(database.metrics);

  const storageLocal: LocalPreferencesStorage = {
    get: (keys) => browser.storage.local.get<Record<string, unknown>>(keys),
    set: (items) => browser.storage.local.set<Record<string, unknown>>(items),
  };

  const sessionStorage: SessionStorageLike = {
    get: (keys) => browser.storage.session.get<Record<string, unknown>>(keys),
    set: (items) => browser.storage.session.set<Record<string, unknown>>(items),
  };

  const action: BrowserActionLike = {
    async setBadgeText(details: { text: string }): Promise<void> {
      await browser.action.setBadgeText(details);
    },
    async setBadgeBackgroundColor(details: { color: string }): Promise<void> {
      await browser.action.setBadgeBackgroundColor(details);
    },
  };

  const preferences = new LocalPreferences(storageLocal);
  const preferenceMutations = new PreferenceMutationCoordinator({
    preferences,
    storage: storageLocal,
  });
  const diagnostics = new DiagnosticRecorder({ now: () => Date.now() });
  // BLOCKING 2: the machine tracks EXPLICIT socket open/closed state per
  // tab - no activity-age heuristic, so an idle-but-open authenticated socket
  // never flips to stale/login-required.
  const connectionState = new ConnectionStateMachine();
  const pumpLeader = new PumpLeaderCoordinator();

  const recordStorageFailure = (): void => {
    diagnostics.record({ code: 'storage_failure', messageType: 'background' });
  };

  const recordAudioPlaybackFailure = (): void => {
    diagnostics.record({
      code: 'audio_playback_failure',
      messageType: 'sound.playBuy',
    });
  };

  const audioPlayer = createOffscreenBuyAudioPlayer(
    browser as unknown as OffscreenAudioChrome,
    recordAudioPlaybackFailure,
  );
  const liveBuyNotifier = createLiveBuyNotifier({
    preferences,
    audio: audioPlayer,
    onFailure: recordAudioPlaybackFailure,
  });
  const tokenNavigationChrome: TokenNavigationChrome = {
    tabs: {
      query: async (query) => (await browser.tabs.query(query)).map((tab) => ({
        ...(tab.id === undefined ? {} : { id: tab.id }),
        windowId: tab.windowId,
        ...(tab.lastAccessed === undefined ? {} : { lastAccessed: tab.lastAccessed }),
      })),
      update: (tabId, update) => browser.tabs.update(tabId, update),
      create: (create) => browser.tabs.create(create),
    },
    windows: {
      getLastFocused: async () => {
        const window = await browser.windows.getLastFocused();
        return window.id === undefined ? {} : { id: window.id };
      },
      update: (windowId, update) => browser.windows.update(windowId, update),
    },
  };

  const floatWindowChrome: FloatWindowChrome = {
    windows: {
      create: async (create) => (await browser.windows.create(create)) ?? {},
      get: async (windowId) => {
        const window = await browser.windows.get(windowId);
        return {
          ...(window.id === undefined ? {} : { id: window.id }),
          ...(window.state === 'normal' || window.state === 'minimized'
            ? { state: window.state }
            : {}),
        };
      },
      update: (windowId, update) => browser.windows.update(windowId, update),
      remove: (windowId) => browser.windows.remove(windowId),
    },
    runtime: {
      getURL: (path) => browser.runtime.getURL(path as '/floatpanel.html'),
    },
  };
  const floatWindowManager = new FloatWindowManager(floatWindowChrome, {
    session: sessionStorage,
    local: storageLocal,
  });
  const captureRecovery = new CaptureRecovery({
    tabs: {
      query: async (query) => (await browser.tabs.query(query)).map((tab) => ({
        ...(tab.id === undefined ? {} : { id: tab.id }),
        ...(tab.lastAccessed === undefined ? {} : { lastAccessed: tab.lastAccessed }),
      })),
      reload: (tabId) => browser.tabs.reload(tabId),
      create: (options) => browser.tabs.create(options),
      sendMessage: (tabId, message) => browser.tabs.sendMessage(tabId, message),
    } satisfies CaptureRecoveryTabs,
    storage: sessionStorage,
  });

  /**
   * Current display mode, seeded from storage at bootstrap and updated on
   * every preferences change. action.onClicked reads it to decide between
   * opening the side panel (default) and opening/focusing the single global
   * float window.
   */
  let currentDisplayMode: 'sidepanel' | 'floating' = 'sidepanel';
  const sidePanelChrome = (
    globalThis as typeof globalThis & { chrome?: ChromeWithOptionalSidePanel }
  ).chrome ?? browser as unknown as ChromeWithOptionalSidePanel;
  const sidePanelInstanceTokens = new Map<number, string>();
  let sidePanelTokenMutation = Promise.resolve();
  const readSidePanelToken = async (windowId: number): Promise<string | undefined> => {
    const cached = sidePanelInstanceTokens.get(windowId);
    if (cached !== undefined) return cached;
    const stored = await sessionStorage.get([SIDE_PANEL_INSTANCE_TOKENS_SESSION_KEY]);
    const registry = stored[SIDE_PANEL_INSTANCE_TOKENS_SESSION_KEY];
    if (typeof registry !== 'object' || registry === null || Array.isArray(registry)) {
      return undefined;
    }
    const token = (registry as Record<string, unknown>)[String(windowId)];
    if (typeof token !== 'string' || token.length === 0 || token.length > 128) return undefined;
    sidePanelInstanceTokens.set(windowId, token);
    return token;
  };
  const writeSidePanelToken = (
    windowId: number,
    instanceToken: string | undefined,
  ): Promise<void> => {
    const mutation = sidePanelTokenMutation.catch(() => {}).then(async () => {
      const stored = await sessionStorage.get([SIDE_PANEL_INSTANCE_TOKENS_SESSION_KEY]);
      const raw = stored[SIDE_PANEL_INSTANCE_TOKENS_SESSION_KEY];
      const registry = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
        ? { ...raw as Record<string, unknown> }
        : {};
      if (instanceToken === undefined) delete registry[String(windowId)];
      else registry[String(windowId)] = instanceToken;
      await sessionStorage.set({ [SIDE_PANEL_INSTANCE_TOKENS_SESSION_KEY]: registry });
      if (instanceToken === undefined) sidePanelInstanceTokens.delete(windowId);
      else sidePanelInstanceTokens.set(windowId, instanceToken);
    });
    sidePanelTokenMutation = mutation;
    return mutation;
  };
  const surfaceSwitchCoordinator = new SurfaceSwitchCoordinator({
    operations: {
      openFloating: async (ownerWindowId, instanceToken) => {
        const result = await floatWindowManager.openOrFocus(ownerWindowId, instanceToken);
        return result.ok ? result.windowId : false;
      },
      openSidePanel: (sourceWindowId) => openSidePanelForWindow(
        floatWindowManager.cachedOwnerWindowId() ?? sourceWindowId,
        sidePanelChrome,
      ),
      closeFloating: (expected) => expected === undefined
        ? floatWindowManager.close()
        : 'sessionId' in expected
          ? floatWindowManager.closeExpectedPip(expected.hostWindowId, expected.sessionId)
          : floatWindowManager.closeExpectedWindow(
            expected.hostWindowId,
            expected.instanceToken,
          ),
      closeSidePanel: async (_sourceWindowId, expected) => {
        if (expected === undefined) return false;
        const currentToken = await readSidePanelToken(expected.hostWindowId);
        if (currentToken === undefined) return false;
        if (currentToken !== expected.instanceToken) return true;
        const closed = await closeSidePanelForWindow(expected.hostWindowId, sidePanelChrome);
        if (closed && sidePanelInstanceTokens.get(expected.hostWindowId) === currentToken) {
          sidePanelInstanceTokens.delete(expected.hostWindowId);
          void writeSidePanelToken(expected.hostWindowId, undefined).catch(() => {});
        }
        return closed;
      },
      isSourceLive: async (transaction) => {
        const identity = transaction.sourceIdentity;
        if (identity === undefined) return false;
        if (transaction.source === 'sidepanel') {
          if (!('instanceToken' in identity)) return false;
          return await readSidePanelToken(identity.hostWindowId) === identity.instanceToken;
        }
        if ('sessionId' in identity) {
          const active = await floatWindowManager.activePipSession();
          return active.ok
            && active.session?.hostWindowId === identity.hostWindowId
            && active.session.sessionId === identity.sessionId;
        }
        return floatWindowManager.surfaceInstanceMatches(
          identity.hostWindowId,
          identity.instanceToken,
        );
      },
      saveDisplayMode: async (mode) => {
        await preferenceMutations.mutate({
          mutationId: `background-display-${crypto.randomUUID()}`,
          type: 'settings',
          update: { displayMode: mode },
        });
        currentDisplayMode = mode;
        await applyDisplayModeToAction(mode, sidePanelChrome);
      },
    },
    storage: sessionStorage,
    onAwaitingReady: (transaction) => {
      const started: ExtensionMessage = {
        protocolVersion: 1,
        type: 'surface.switch.started',
        payload: { switchId: transaction.switchId, target: transaction.target },
      };
      void browser.runtime.sendMessage(started).catch(() => {});
    },
  });

  const broadcastSurfaceSwitchChanged = (
    result: Awaited<ReturnType<SurfaceSwitchCoordinator['request']>>,
  ): void => {
    const changed: ExtensionMessage = {
      protocolVersion: 1,
      type: 'surface.switch.changed',
      payload: result,
    };
    void browser.runtime.sendMessage(changed).catch(() => {});
  };

  // When the side panel behavior is OFF (floating mode), Chrome fires
  // action.onClicked instead of opening the panel. The listener must ALWAYS
  // be registered (registering it does not suppress the side panel; only
  // openPanelOnActionClick:false does) so mode flips need no re-registration.
  browser.action.onClicked.addListener((tab) => {
    if (currentDisplayMode !== 'floating') {
      return;
    }
    void floatWindowManager.openOrFocus(tab.windowId).then((result) => {
      if (!result.ok) {
        diagnostics.record({
          code: 'storage_failure',
          messageType: 'float.open',
        });
      }
    }).catch(() => {});
  });

  const pipelineHealth = new PersistedPipelineHealth({
    storage: sessionStorage,
    now: () => Date.now(),
    onStorageFailure: recordStorageFailure,
  });
  // Side Panel runtime messages do not consistently carry a tab id. Keep the
  // most recently active, sender-validated Fomo content-script tab as the
  // fallback endpoint for local translation commands.
  let latestFomoContentTabId: number | undefined;

  let pipelineHealthNotificationTimer: ReturnType<typeof setTimeout> | undefined;
  const schedulePipelineHealthChanged = (): void => {
    clearTimeout(pipelineHealthNotificationTimer);
    pipelineHealthNotificationTimer = setTimeout(() => {
      pipelineHealthNotificationTimer = undefined;
      const changed: ExtensionMessage = {
        protocolVersion: 1,
        type: 'pipeline.healthChanged',
      };
      void browser.runtime.sendMessage(changed).catch(() => {});
    }, PIPELINE_HEALTH_NOTIFICATION_DELAY_MS);
  };

  const recordPipelineHealth = async (
    event: Parameters<PersistedPipelineHealth['record']>[0],
  ): Promise<void> => {
    await pipelineHealth.record(event);
    schedulePipelineHealthChanged();
  };

  const broadcastToOverlays = async (_message: BroadcastActivityMessage): Promise<void> => {
    // Extension UI surfaces query durable storage after this invalidation. Do
    // not copy a trade payload into every unrelated browser tab.
    const changed: ExtensionMessage = { protocolVersion: 1, type: 'events.changed' };
    await browser.runtime.sendMessage(changed).catch(() => {});
  };

  const metricSource = new CachedTraderMetricSource({
    // EVIDENCE GATE (plan Task 8): the FomoLeaderboardMetricSource adapter is
    // intentionally NOT enabled. Enabling it requires one REAL authenticated
    // capture of GET https://prod-api.fomo.family/v2/users/{traderId}/leaderboard,
    // redacted and promoted to tests/fixtures/fomo-metrics-7d.redacted.json
    // (today that fixture is explicitly synthetic — see
    // docs/evidence/fomo-metrics-contract.md, status PROVISIONAL-UNVERIFIED).
    // Until then the production root keeps source: unavailableMetricSource and
    // never issues the request; enrichment stays unavailable and cards render
    // base fields. The parser and its tests are production-ready, so enabling
    // the adapter is a one-line swap once the evidence gate passes.
    source: unavailableMetricSource,
    cache: metricRepository,
    now: () => Date.now(),
    ttlMs: METRIC_TTL_MS,
    failureBackoffMs: METRIC_FAILURE_BACKOFF_MS,
  });

  const ingestor = new ActivityIngestor({
    events: {
      insert: (event) => eventRepository.insert(event),
      persist: (event) => eventRepository.persist(event),
      update: (id, changes) => database.events.update(id, changes),
    },
    diagnostics,
    rejections: createRejectionCounter(),
    metricSource,
    broadcast: broadcastToOverlays,
    health: { record: recordPipelineHealth },
    liveBuyNotifier,
  });

  // EVIDENCE GATE (plan Task 4): the FomoHistoryClient adapter is
  // intentionally NOT enabled. Enabling it requires one REAL authenticated
  // capture of GET https://prod-api.fomo.family/v2/activities/me, redacted
  // and promoted to docs/evidence/fomo-history-contract.md (today that
  // contract is explicitly PROVISIONAL-UNVERIFIED). Until then the
  // production root wires unavailableHistoryClient and never issues the
  // request; recovery stays unavailable. The adapter, parser, and
  // coordinator are production-ready, so enabling is a one-line swap (to
  // `new FomoHistoryClient({ enabled: true })`) once the evidence gate
  // passes.
  const activitySync = new ActivitySync(
    {
      events: {
        // seedFromStored() reads the newest stored row to seed the watermark.
        page: (query) => eventRepository.page(query),
      },
      ingestor: {
        // Recovered events go through the SAME insert -> broadcast ->
        // enrichment path as live events (provisional-mapping diagnostics and
        // health records included).
        ingestRecovered: (event) => ingestor.ingestRecovered(event),
      },
      history: unavailableHistoryClient,
      // Persisted composite recovery cursor (chrome.storage.local), so a
      // restarted worker resumes the backfill from exactly where it stopped.
      storage: storageLocal,
      health: { record: recordPipelineHealth },
      now: () => Date.now(),
    },
    {
      // Task 5 Step 5: emit sync.changed (payload-less) whenever the
      // coordinator's ActivitySyncState transitions, so the side panel can
      // react without polling.
      onStateChange: () => {
        const changed: ExtensionMessage = { protocolVersion: 1, type: 'sync.changed' };
        void browser.runtime.sendMessage(changed).catch(() => {});
      },
    },
  );

  // The badge phase is recomputed from the PERSISTED per-tab socket state
  // (chrome.storage.session) on every refresh, so it can never be stuck on
  // stale in-memory state. There is deliberately NO stale-boundary timer:
  // a socket close reports connection.changed immediately, which triggers a
  // badge refresh, and bootstrap re-derives the color after a restart
  // (BLOCKING 2).
  const refreshBadge = async (): Promise<void> => {
    await refreshBadgeFromStorage({
      action,
      storage: sessionStorage,
      unreadCount: () => eventRepository.unreadCount(),
    });
  };

  const ingestActivity = async (payload: unknown): Promise<void> => {
    const outcome = await ingestor.ingest({ payload, receivedAt: Date.now() });

    if (outcome.status === 'inserted') {
      await refreshBadge();
      // Task 4: raise the composite recovery watermark (occurredAt + id) so a
      // later backfill only fetches events newer than what the live pipeline
      // has already stored, without dropping same-millisecond events.
      activitySync.observeEvent(outcome.event);
    }
  };

  const ingestPumpBatch = async (
    payload: Extract<ExtensionMessage, { type: 'pump.batch' }>['payload'],
    tabId: number,
  ): Promise<{ ok: boolean; accepted: number }> => {
    if (
      payload.workerSessionId !== pumpLeader.workerSessionId ||
      !pumpLeader.isCurrent(tabId, payload.epoch, Date.now())
    ) {
      return { ok: false, accepted: 0 };
    }

    const page = parsePumpTradePage({ items: payload.items, nextCursor: null });
    // A checkpoint represents the exact payload that reached durable storage.
    // Advancing it after silently discarding malformed items would make those
    // items unrecoverable on the next polling cycle, so the producer must
    // retain and retry the whole logical batch instead.
    if (page.rejectedCount > 0) {
      return { ok: false, accepted: 0 };
    }
    let accepted = 0;
    for (const raw of page.accepted) {
      const event = normalizePumpTrade(raw, payload.at, payload.delivery);
      const outcome = await ingestor.ingestNormalized(event, {
        notifyLiveBuy: payload.delivery === 'live',
      });
      if (outcome.status === 'inserted') {
        accepted += 1;
        await refreshBadge();
      }
    }

    await sessionStorage.set({
      'pump.session.v1': {
        watermark: payload.watermark,
        recentKeys: payload.recentKeys,
      },
    });
    return { ok: true, accepted };
  };

  // BLOCKING 2: the bridge reports per-tab socket state keyed by the
  // content-script sender's tab id, so a logged-OUT second tab reporting
  // page-presence cannot reset the connected state of a tab whose
  // authenticated socket is open.
  const tabKeyFromSender = (sender: SenderForGuard): string =>
    sender.tab?.id !== undefined ? String(sender.tab.id) : 'unknown';

  const handleConnectionChanged = async (
    payload: { connected: boolean; authenticated: boolean; at: number },
    tabKey: string,
  ): Promise<void> => {
    connectionState.report(tabKey, payload);

    // Persist the per-tab state so a restarted worker can re-seed the machine
    // AND the badge phase; session storage is ephemeral and never part of
    // event history.
    await writeConnectionState(sessionStorage, {
      tabs: connectionState.persisted().map(([entryTabKey, state]) => ({
        tabKey: entryTabKey,
        authenticated: state.authenticated,
        socketOpen: state.socketOpen,
        reportedAt: state.reportedAt,
      })),
    });
    await refreshBadge();
  };

  const removeTabConnection = async (tabId: number): Promise<void> => {
    const tabKey = String(tabId);
    if (!connectionState.persisted().some(([entryTabKey]) => entryTabKey === tabKey)) {
      return;
    }
    connectionState.removeTab(tabKey);
    if (latestFomoContentTabId === tabId) {
      latestFomoContentTabId = undefined;
    }
    await writeConnectionState(sessionStorage, {
      tabs: connectionState.persisted().map(([entryTabKey, state]) => ({
        tabKey: entryTabKey,
        authenticated: state.authenticated,
        socketOpen: state.socketOpen,
        reportedAt: state.reportedAt,
      })),
    });
    await refreshBadge();
    const snapshot = connectionState.snapshot();
    const changed: ExtensionMessage = {
      protocolVersion: 1,
      type: 'connection.changed',
      payload: { ...snapshot, at: Date.now() },
    };
    void browser.runtime.sendMessage(changed).catch(() => {});
  };

  const removePumpTab = (tabId: number): void => {
    pumpLeader.remove(tabId, Date.now());
    if (pumpLeader.trackedTabIds().length === 0) {
      void sessionStorage.set({
        'pump.session.v1': null,
        'pump.status.v1': null,
      }).catch(recordStorageFailure);
    }
  };

  browser.tabs.onRemoved.addListener((tabId) => {
    void removeTabConnection(tabId).catch(recordStorageFailure);
    removePumpTab(tabId);
  });

  browser.windows.onRemoved.addListener((windowId) => {
    void floatWindowManager.handleWindowRemoved(windowId).catch(() => {});
  });

  browser.windows.onBoundsChanged.addListener((window) => {
    if (
      window.id === undefined ||
      window.width === undefined ||
      window.height === undefined
    ) {
      return;
    }

    void floatWindowManager.handleWindowBoundsChanged(window.id, {
      width: window.width,
      height: window.height,
      ...(window.left !== undefined ? { left: window.left } : {}),
      ...(window.top !== undefined ? { top: window.top } : {}),
    }).catch(() => {});
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const nextUrl = changeInfo.url;
    if (
      nextUrl !== undefined &&
      !PUMP_ORIGINS.some((origin) => nextUrl === origin || nextUrl.startsWith(`${origin}/`))
    ) {
      removePumpTab(tabId);
    }
    if (
      changeInfo.status === 'loading' ||
      (nextUrl !== undefined &&
        !FOMO_ORIGINS.some((origin) => nextUrl === origin || nextUrl.startsWith(`${origin}/`)))
    ) {
      void removeTabConnection(tabId).catch(recordStorageFailure);
    }
  });

  const handleQuery = async (query: EventQuery): Promise<EventsQueryResponse> => {
    // `search` is a popup-side, post-page concern (see src/messaging/protocol.ts);
    // the storage layer never receives or executes it.
    const pageQuery: EventPageQuery = {
      limit: query.limit,
      ...(query.beforeOccurredAt !== undefined
        ? { beforeOccurredAt: query.beforeOccurredAt }
        : {}),
      ...(query.beforeId !== undefined ? { beforeId: query.beforeId } : {}),
      ...(query.traderId !== undefined ? { traderId: query.traderId } : {}),
      ...(query.chain !== undefined ? { chain: query.chain } : {}),
      ...(query.tokenAddress !== undefined ? { tokenAddress: query.tokenAddress } : {}),
      ...(query.unreadOnly !== undefined ? { unreadOnly: query.unreadOnly } : {}),
    };

    const events = await eventRepository.page(pageQuery);

    return { ok: true, events };
  };

  const handleMarkRead = async (payload: {
    ids: string[];
    at: number;
  }): Promise<MarkReadResponse> => {
    let marked = 0;

    for (const id of payload.ids) {
      if (await eventRepository.markRead(id, payload.at)) {
        marked += 1;
      }
    }

    await refreshBadge();

    return { ok: true, marked };
  };

  const handleConnectionQuery = async (): Promise<ConnectionQueryResponse> => {
    const [snapshot, tabs, pumpTabs, stored, local] = await Promise.all([
      Promise.resolve(connectionState.snapshot()),
      browser.tabs.query({ url: FOMO_TAB_URL_PATTERNS }),
      browser.tabs.query({ url: PUMP_TAB_URL_PATTERNS }),
      sessionStorage.get(['pump.status.v1']),
      storageLocal.get([PUMP_GAP_STORAGE_KEY]),
    ]);
    const pumpStatus = parsePumpStatusSnapshot(stored['pump.status.v1']);
    const pumpGap = parsePumpGapState(local[PUMP_GAP_STORAGE_KEY]);
    const hasPumpTab = pumpTabs.some((tab) => {
      if (typeof tab.url !== 'string') return false;
      try {
        const url = new URL(tab.url);
        return url.protocol === 'https:' && PUMP_ORIGINS.some((origin) => origin === url.origin);
      } catch {
        return false;
      }
    });
    const effectivePumpStatus = pumpStatus !== undefined &&
      (pumpStatus.status === 'live' || pumpStatus.status === 'catching-up') &&
      Date.now() - pumpStatus.at > 5_000
      ? { ...pumpStatus, status: 'delayed' as const }
      : pumpStatus;

    return {
      ok: true,
      connected: snapshot.connected,
      authenticated: snapshot.authenticated,
      hasFomoTab: tabs.length > 0,
      ...(hasPumpTab ? {
        pump: effectivePumpStatus === undefined
          ? {
              hasPumpTab: true,
              status: 'disconnected',
              at: Date.now(),
              backoffLevel: 0,
              ...(pumpGap === undefined ? {} : { gap: pumpGap }),
            }
          : {
              hasPumpTab: true,
              ...effectivePumpStatus,
              ...(pumpGap === undefined ? {} : { gap: pumpGap }),
            },
      } : {}),
    };
  };

  const handlePipelineHealthQuery = async (): Promise<PipelineHealthQueryResponse> => ({
    ok: true,
    health: await pipelineHealth.snapshot(),
  });

  const handleTranslationRequest = async (
    message: TranslationRequestMessage,
    preferredTabId: number | undefined,
  ): Promise<unknown> => {
    const tabs = await browser.tabs.query({ url: FOMO_TAB_URL_PATTERNS });
    const sessionRoute = translationSessionRoute(message);
    const tab = sessionRoute === undefined
      ? tabs.find((candidate) => candidate.id === preferredTabId)
      ?? tabs.find((candidate) => candidate.active && candidate.id !== undefined)
      ?? tabs.find((candidate) => candidate.id === latestFomoContentTabId)
      ?? tabs.find((candidate) => candidate.id !== undefined)
      : tabs.find((candidate) => candidate.id === sessionRoute.tabId);
    if (tab?.id === undefined) {
      return {
        ok: false,
        error: { code: sessionRoute === undefined ? 'fomo-tab-required' : 'context-disposed' },
      };
    }
    try {
      const reply = await browser.tabs.sendMessage(
        tab.id,
        forwardTranslationMessage(message, sessionRoute?.hostSessionId),
      );
      return message.payload.command === 'create' || message.payload.command === 'initialize'
        ? bindTranslationCreateReply(reply, tab.id)
        : reply;
    } catch {
      return { ok: false, error: { code: 'context-disposed' } };
    }
  };

  // Task 5 Step 5: the recovery coordinator's live ActivitySyncState for the
  // side panel/popup sync.query.
  const handleSyncQuery = (): SyncQueryResponse => ({
    ok: true,
    state: activitySync.status(),
  });

  // Bounded retention, scheduled by a PERSISTED due-time instead of an
  // in-memory nextRetentionAt that every worker restart re-armed to now+6h
  // (BLOCKING 2): the last-run timestamp lives in chrome.storage.session, so
  // a due run happens promptly on startup and survives worker suspension.
  const retentionScheduler = new RetentionScheduler({
    storage: sessionStorage,
    runRetentionFn: (now) => runRetention(database, { now }),
    diagnostics,
    now: () => Date.now(),
  });

  let pipRuntimeStateHydrated = false;
  const hydratePipRuntimeState = async (): Promise<void> => {
    try {
      await floatWindowManager.recoverStoredPipSession();
    } finally {
      pipRuntimeStateHydrated = true;
    }
  };

  const bootstrap = async (): Promise<void> => {
    const restoreSurfaceSwitch = surfaceSwitchCoordinator.restore();
    // Hydrate persisted capability caches without delaying listener setup.
    // A trusted float host can supply its issued context while this is pending,
    // preserving Chrome's synchronous user-activation boundary.
    await Promise.all([hydratePipRuntimeState(), restoreSurfaceSwitch]);

    // Seed the display mode before wiring the action behavior so the action
    // routes to the right surface from the very first click.
    const settings = await preferences.getSettings().catch(() => undefined);
    if (settings !== undefined) {
      currentDisplayMode = settings.displayMode;
    }

    const sidePanel = await configureActionSidePanel().catch(() => ({ supported: false }));
    if (!sidePanel.supported) {
      diagnostics.record({
        code: 'storage_failure',
        messageType: 'sidepanel.bootstrap',
      });
    } else {
      // configureActionSidePanel forces openPanelOnActionClick:true; re-apply
      // the display-mode routing so floating mode opens the float window
      // instead of the panel.
      await applyDisplayModeToAction(currentDisplayMode).catch(() => false);
    }

    // BLOCKING 2: re-seed the machine from the persisted per-tab socket
    // state, trusting ONLY entries whose tab id still exists - a stale
    // socketOpen from a closed tab is never trusted.
    const persisted = await readConnectionState(sessionStorage);

    if (persisted !== undefined) {
      const liveTabs = await browser.tabs.query({});
      const liveTabKeys = new Set(
        liveTabs
          .map((tab) => tab.id)
          .filter((id): id is number => typeof id === 'number')
          .map(String),
      );

      for (const entry of persisted.tabs) {
        if (liveTabKeys.has(entry.tabKey)) {
          connectionState.report(entry.tabKey, {
            connected: entry.socketOpen,
            authenticated: entry.authenticated,
            at: entry.reportedAt,
          });
        }
      }
    }

    // Task 2: idempotent bootstrap reclassification. Stored rows whose chain
    // is 'unknown' and whose networkId now maps to a verified-from-capture
    // chain are reclassified. A second run updates zero rows.
    const verifiedMappings = new Map(
      NETWORK_CATALOG.filter(
        (entry) => entry.status === 'verified-from-capture',
      ).map((entry) => [entry.networkId, entry.chain] as const),
    );
    const reclassification = await reclassifyUnknownChainEvents(
      database.events,
      verifiedMappings,
    );

    if (reclassification.updated > 0) {
      void browser.runtime.sendMessage({
        protocolVersion: 1,
        type: 'events.changed',
      }).catch(() => undefined);
    }

    // Task 4: seed the recovery watermark. The persisted composite cursor is
    // authoritative; a missing or corrupt cursor falls back to the newest
    // stored row, then to pipeline health (or a cold-start max-gap window).
    const cursorSeeded = await activitySync.seedFromCursor().catch(() => false);

    if (!cursorSeeded) {
      await activitySync.seedFromStored().catch(recordStorageFailure);

      const healthSnapshot = await pipelineHealth.snapshot();
      activitySync.seedLatest(healthSnapshot.latestEventOccurredAt);
    }

    await retentionScheduler.seed();
    await retentionScheduler.maybeRun();
    await refreshBadge();
  };

  void bootstrap().catch(recordStorageFailure);

  browser.runtime.onMessage.addListener(
    createRuntimeMessageDispatcher((rawMessage: unknown, sender: SenderForGuard) => {
      const parsed = parseExtensionMessage(rawMessage);

      if (!parsed.ok) {
        return undefined;
      }

      const message = parsed.message;

      if (!isTrustedSenderForMessage(toSenderLike(sender), message.type, browser.runtime.id)) {
        return undefined;
      }

      switch (message.type) {
        case 'pip.opened':
        case 'pip.ready':
        case 'pip.closed':
        case 'pip.returnToSidePanel':
          if (!isTrustedFloatHostSender(
            toSenderLike(sender),
            browser.runtime.id,
            message.payload.hostWindowId,
          )) {
            return undefined;
          }
          break;
        default:
          break;
      }

      if (
        sender.tab?.id !== undefined &&
        (message.type === 'activity.ingest' ||
          message.type === 'connection.changed' ||
          message.type === 'pipeline.healthEvent' ||
          message.type === 'translation.ready' ||
          message.type === 'translation.hostReady')
      ) {
        latestFomoContentTabId = sender.tab.id;
      }

      switch (message.type) {
        case 'pump.lease.request': {
          const tabId = sender.tab?.id;
          if (tabId === undefined) return undefined;
          const leaseNow = Date.now();
          const decision = message.payload.epoch === undefined ||
            message.payload.workerSessionId !== pumpLeader.workerSessionId
            ? pumpLeader.register(tabId, leaseNow)
            : pumpLeader.renew(tabId, message.payload.epoch, leaseNow);
          return sessionStorage.get(['pump.session.v1']).then((stored) => {
            const seed = parsePumpSessionState(stored['pump.session.v1']);
            return {
              ok: true as const,
              workerSessionId: pumpLeader.workerSessionId,
              ...decision,
              ...(decision.granted && seed !== undefined ? { seed } : {}),
            };
          });
        }
        case 'pump.batch': {
          const tabId = sender.tab?.id;
          return tabId === undefined
            ? undefined
            : ingestPumpBatch(message.payload, tabId).catch(() => {
                recordStorageFailure();
                return { ok: false, accepted: 0 };
              });
        }
        case 'pump.status':
          if (sender.tab?.id !== undefined &&
              message.payload.workerSessionId === pumpLeader.workerSessionId &&
              pumpLeader.isCurrent(sender.tab.id, message.payload.epoch, Date.now())) {
            if (message.payload.status === 'possible-gap') {
              void storageLocal.set({
                [PUMP_GAP_STORAGE_KEY]: createPumpGapState(message.payload.at),
              }).catch(recordStorageFailure);
            }
            void sessionStorage.set({ 'pump.status.v1': message.payload }).catch(recordStorageFailure);
            const changed: ExtensionMessage = {
              protocolVersion: 1,
              type: 'pump.statusChanged',
              payload: message.payload,
            };
            void browser.runtime.sendMessage(changed).catch(() => {});
          }
          return undefined;
        case 'pump.statusChanged':
          return undefined;
        case 'pump.pageHidden':
          if (sender.tab?.id !== undefined &&
              message.payload.workerSessionId === pumpLeader.workerSessionId &&
              pumpLeader.isCurrent(sender.tab.id, message.payload.epoch, Date.now())) {
            removePumpTab(sender.tab.id);
          }
          return undefined;
        case 'activity.ingest':
          void ingestActivity(message.payload).catch(recordStorageFailure);
          void retentionScheduler.maybeRun().catch(recordStorageFailure);
          return undefined;
        case 'activity.broadcast':
          // Outbound-only worker -> overlay message; the sender guard above
          // already rejected it (trustClassForMessageType returns null), so
          // this branch is unreachable and exists only for exhaustiveness.
          return undefined;
        case 'events.changed':
          return undefined;
        case 'pipeline.healthEvent':
          return recordPipelineHealth(message.payload);
        case 'pipeline.healthQuery':
          return handlePipelineHealthQuery();
        case 'pipeline.healthChanged':
          return undefined;
        case 'connection.changed':
          void handleConnectionChanged(message.payload, tabKeyFromSender(sender)).catch(
            recordStorageFailure,
          );

          // Task 4: reconnected + authenticated -> bounded single-flight
          // backfill. Repeated reports during an in-flight run are no-ops
          // (single-flight), and the disabled history client keeps this a
          // no-op in production until the evidence gate passes.
          if (message.payload.connected && message.payload.authenticated) {
            void activitySync.sync({ reason: 'reconnect' }).catch(recordStorageFailure);
          }

          return undefined;
        case 'events.query':
          void retentionScheduler.maybeRun().catch(recordStorageFailure);

          return handleQuery(message.payload).catch((error: unknown) => {
            recordStorageFailure();
            throw error;
          });
        case 'events.markRead':
          void retentionScheduler.maybeRun().catch(recordStorageFailure);

          return handleMarkRead(message.payload).catch((error: unknown) => {
            recordStorageFailure();
            throw error;
          });
        case 'diagnostics.record': {
          // BLOCKING 3: the popup reports rows it had to drop; the bounded
          // DiagnosticRecorder ring buffer sanitizes and caps storage.
          const payload = message.payload;

          diagnostics.record({
            code: payload.code,
            ...(payload.schemaVersion !== undefined
              ? { schemaVersion: payload.schemaVersion }
              : {}),
            ...(payload.messageType !== undefined
              ? { messageType: payload.messageType }
              : {}),
            ...(payload.missingFields !== undefined
              ? { missingFields: [...payload.missingFields] }
              : {}),
          });
          return undefined;
        }
        case 'connection.query':
          return handleConnectionQuery().catch((error: unknown) => {
            recordStorageFailure();
            throw error;
          });
        case 'preferences.changed':
          // A preferences write may have flipped displayMode; re-read and
          // re-route the action so the next click opens the new surface.
          void preferences.getSettings().then((next) => {
            if (next.displayMode !== currentDisplayMode) {
              currentDisplayMode = next.displayMode;
              void applyDisplayModeToAction(currentDisplayMode).catch(() => {});
            }
          }).catch(() => {});
          return undefined;
        case 'annotations.mutate':
          {
            const update: TraderAnnotationUpdate = {
                ...(message.payload.update?.label !== undefined
                  ? { label: message.payload.update.label }
                  : {}),
                ...(message.payload.update?.color !== undefined
                  ? { color: message.payload.update.color }
                  : {}),
                ...(message.payload.update?.pinned !== undefined
                  ? { pinned: message.payload.update.pinned }
                  : {}),
                ...(message.payload.update?.muted !== undefined
                  ? { muted: message.payload.update.muted }
                  : {}),
              };
            const mutationId = message.payload.mutationId ?? crypto.randomUUID();
            return preferenceMutations.mutate(message.payload.delete
              ? {
                mutationId,
                type: 'annotation-delete',
                traderId: message.payload.traderId,
                at: message.payload.at,
              }
              : {
                mutationId,
                type: 'annotation-upsert',
                traderId: message.payload.traderId,
                update,
                at: message.payload.at,
              },
            ).then((result) => result.type === 'annotation'
              ? { ok: true as const, annotation: result.annotation }
              : { ok: false as const })
              .catch(() => ({ ok: false as const }));
          }
        case 'settings.mutate':
          // The wire schema validates this exact partial shape before the
          // dispatch switch. The assertion bridges Zod's optional-property
          // output to the project's exact-optional TypeScript setting.
          return preferenceMutations.mutate({
            mutationId: message.payload.mutationId ?? crypto.randomUUID(),
            type: 'settings',
            update: message.payload.update as LocalSettingsUpdate,
          }).then((result) => result.type === 'settings'
            ? { ok: true as const, settings: result.settings }
            : { ok: false as const })
            .catch(() => ({ ok: false as const }));
        case 'float.open':
          return floatWindowManager.openOrFocus().then((result) => {
            if (!result.ok) {
              diagnostics.record({
                code: 'storage_failure',
                messageType: 'float.open',
              });
            }
            return result;
          });
        case 'float.geometryChanged':
          return floatWindowManager
            .saveGeometry(message.payload as FloatWindowGeometry)
            .then(() => ({ ok: true as const }))
            .catch(() => ({ ok: false as const }));
        case 'surface.switch.request': {
          if (surfaceSwitchCoordinator.isAdmissionBlocked(message.payload.switchId)) return {
            ok: false as const,
            switchId: message.payload.switchId,
            reason: 'switch-in-progress' as const,
          };
          const requestSwitch = (): Promise<SurfaceSwitchResult> =>
            surfaceSwitchCoordinator.request({
              switchId: message.payload.switchId,
              source: message.payload.source,
              target: message.payload.target,
              sourceWindowId: message.payload.sourceWindowId,
              sourceIdentity: {
                hostWindowId: message.payload.sourceWindowId,
                instanceToken: message.payload.instanceToken,
              },
              ...(message.payload.target === 'sidepanel'
                ? {
                  targetIdentity: {
                    hostWindowId: floatWindowManager.cachedOwnerWindowId()
                      ?? message.payload.sourceWindowId,
                  },
                }
                : {}),
            }).then((result) => {
              broadcastSurfaceSwitchChanged(result);
              return result;
            });
          const staleResult = {
            ok: false as const,
            switchId: message.payload.switchId,
            reason: 'stale-switch' as const,
          };
          if (message.payload.source === 'sidepanel') {
            return readSidePanelToken(message.payload.sourceWindowId).then((token) => (
              token === message.payload.instanceToken ? requestSwitch() : staleResult
            ));
          }
          return floatWindowManager.surfaceInstanceMatches(
            message.payload.sourceWindowId,
            message.payload.instanceToken,
          ).then((matches) => (matches ? requestSwitch() : staleResult));
        }
        case 'surface.bootstrap': {
          void captureRecovery.ensureCapture('surface-open').catch(() => {});
          const identity = {
            hostWindowId: message.payload.windowId,
            instanceToken: message.payload.instanceToken,
          };
          const register = message.payload.surface === 'floating'
            ? floatWindowManager.registerSurfaceInstance(
              message.payload.windowId,
              message.payload.instanceToken,
            )
            : writeSidePanelToken(
              message.payload.windowId,
              message.payload.instanceToken,
            );
          return register.then(() => Promise.all([
            surfaceSwitchCoordinator.bootstrap(message.payload.surface, identity),
            message.payload.surface === 'floating'
              ? floatWindowManager.ownerWindowId()
              : Promise.resolve(undefined),
          ])).then(
            ([transaction]) => ({
              ok: true as const,
              ...(transaction === undefined ? {} : { transaction }),
            }),
          );
        }
        case 'surface.ready': {
          const tokenMatches = message.payload.surface === 'sidepanel'
            ? sidePanelInstanceTokens.get(message.payload.windowId)
              === message.payload.instanceToken
            : floatWindowManager.cachedSurfaceInstanceMatches(
              message.payload.windowId,
              message.payload.instanceToken,
            );
          if (!tokenMatches) return {
            ok: false as const,
            switchId: message.payload.switchId,
            reason: 'stale-switch' as const,
          };
          return surfaceSwitchCoordinator.ready({
            switchId: message.payload.switchId,
            surface: message.payload.surface,
            eventWatermark: message.payload.eventWatermark,
            targetIdentity: {
              hostWindowId: message.payload.windowId,
              instanceToken: message.payload.instanceToken,
            },
          });
        }
        case 'surface.switch.changed':
        case 'surface.switch.started':
          return undefined;
        case 'pip.opened':
          return floatWindowManager.registerPipOpened(
            message.payload.hostWindowId,
            message.payload.sessionId,
          );
        case 'pip.ready':
          return floatWindowManager.markPipReady(
            message.payload.hostWindowId,
            message.payload.sessionId,
          );
        case 'pip.closed':
          return floatWindowManager.handlePipClosed(
            message.payload.hostWindowId,
            message.payload.sessionId,
            message.payload.reason,
          );
        case 'pip.returnToSidePanel': {
          const { hostWindowId, sessionId, ownerWindowId, switchId } = message.payload;
          const cachedMatch = floatWindowManager.cachedPipReturnContextMatches(
            hostWindowId,
            sessionId,
            ownerWindowId,
          );
          const coldMatch = !cachedMatch
            && !pipRuntimeStateHydrated
            && floatWindowManager.adoptTrustedColdReturnContext(
              hostWindowId,
              sessionId,
              ownerWindowId,
            );
          if (!cachedMatch && !coldMatch) {
            return {
              ok: false as const,
              switchId,
              reason: 'stale-switch' as const,
            };
          }

          const result = surfaceSwitchCoordinator.requestTrustedWhileRestoring({
            switchId,
            source: 'floating',
            target: 'sidepanel',
            sourceWindowId: ownerWindowId,
            sourceIdentity: { hostWindowId, sessionId },
            targetIdentity: { hostWindowId: ownerWindowId },
          });
          void result.then(broadcastSurfaceSwitchChanged).catch(() => {});
          return result;
        }
        case 'sync.request':
          // Task 5 Step 5: the side panel/popup asks for a bounded backfill.
          // Single-flight makes a request racing a reconnect backfill a no-op.
          void activitySync.sync({ reason: message.payload.reason }).catch(
            recordStorageFailure,
          );

          return undefined;
        case 'sync.query':
          return handleSyncQuery();
        case 'sync.changed':
          // Outbound-only worker -> side panel notification; the sender guard
          // above already rejected it (trustClassForMessageType returns null),
          // so this branch is unreachable and exists only for exhaustiveness.
          return undefined;
        case 'navigation.openToken':
          return openActivityToken(tokenNavigationChrome, message.payload).then((result) => {
            if (!result.ok && result.reason === 'chrome-api-failed') {
              diagnostics.record({
                code: 'token_navigation_failure',
                messageType: 'navigation.openToken',
              });
            }
            return result;
          });
        case 'translation.request':
          return handleTranslationRequest(message, sender.tab?.id);
        case 'translation.ready':
          void browser.runtime.sendMessage(message).catch(() => {});
          return undefined;
        case 'translation.hostReady':
          return undefined;
      }
    }),
  );
});
