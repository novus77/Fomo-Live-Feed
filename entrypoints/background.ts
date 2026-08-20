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
import { runRetention } from '../src/background/retention';
import { RetentionScheduler } from '../src/background/retention-schedule';
import {
  CachedTraderMetricSource,
  unavailableMetricSource,
} from '../src/fomo/enrichment-client';
import {
  FOMO_ORIGINS,
  isTrustedSenderForMessage,
  type MessageSenderLike,
} from '../src/messaging/guards';
import {
  parseExtensionMessage,
  type ExtensionMessage,
  type ConnectionQueryResponse,
  type EventQuery,
  type PipelineHealthQueryResponse,
} from '../src/messaging/protocol';
import { FomoFeedDatabase } from '../src/storage/database';
import {
  EventRepository,
  type EventPageQuery,
} from '../src/storage/event-repository';
import {
  LocalPreferences,
  type LocalPreferencesStorage,
} from '../src/storage/local-preferences';
import { configureActionSidePanel } from '../src/sidepanel/sidepanel-api';
import { MetricRepository } from '../src/storage/metric-repository';

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

// Fomo tab patterns for the popup connection.query verdict (plan Task 9
// Step 3): derived from the SINGLE shared origin catalog in guards.ts
// (SHOULD-FIX 9) so hosts are declared in exactly one place.
const FOMO_TAB_URL_PATTERNS: string[] = FOMO_ORIGINS.map(
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

// chrome.runtime.MessageSender is not assignable to the guard's minimal
// MessageSenderLike under exactOptionalPropertyTypes (its Tab.url is typed
// string | undefined), so the listener adapts the sender before validation.
interface SenderForGuard {
  id?: string | undefined;
  url?: string | undefined;
  tab?: { url?: string | undefined; id?: number | undefined };
}

const toSenderLike = (sender: SenderForGuard): MessageSenderLike => ({
  ...(sender.id !== undefined ? { id: sender.id } : {}),
  ...(sender.url !== undefined ? { url: sender.url } : {}),
  ...(sender.tab?.url !== undefined ? { tab: { url: sender.tab.url } } : {}),
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
  const diagnostics = new DiagnosticRecorder({ now: () => Date.now() });
  // BLOCKING 2: the machine tracks EXPLICIT socket open/closed state per
  // tab - no activity-age heuristic, so an idle-but-open authenticated socket
  // never flips to stale/login-required.
  const connectionState = new ConnectionStateMachine();

  const recordStorageFailure = (): void => {
    diagnostics.record({ code: 'storage_failure', messageType: 'background' });
  };

  const pipelineHealth = new PersistedPipelineHealth({
    storage: sessionStorage,
    now: () => Date.now(),
    onStorageFailure: recordStorageFailure,
  });

  const recordPipelineHealth = async (
    event: Parameters<PersistedPipelineHealth['record']>[0],
  ): Promise<void> => {
    await pipelineHealth.record(event);
    const changed: ExtensionMessage = {
      protocolVersion: 1,
      type: 'pipeline.healthChanged',
    };
    await browser.runtime.sendMessage(changed).catch(() => {});
  };

  const broadcastToOverlays = async (message: BroadcastActivityMessage): Promise<void> => {
    const tabs = await browser.tabs.query({});

    await Promise.all(
      tabs.map(async (tab) => {
        if (tab.id === undefined) {
          return;
        }

        try {
          await browser.tabs.sendMessage(tab.id, message);
        } catch {
          // Tabs without the overlay content script reject; one failed
          // delivery must never abort the broadcast loop (plan Task 7 Step 3).
        }
      }),
    );
  };

  const metricSource = new CachedTraderMetricSource({
    // The FomoLeaderboardMetricSource adapter is intentionally NOT enabled:
    // plan Task 7 Step 2 requires a real redacted capture
    // (tests/fixtures/fomo-leaderboard-7d.json) before production fetches.
    // Until then enrichment stays unavailable and toasts render base fields.
    source: unavailableMetricSource,
    cache: metricRepository,
    now: () => Date.now(),
    ttlMs: METRIC_TTL_MS,
    failureBackoffMs: METRIC_FAILURE_BACKOFF_MS,
  });

  const ingestor = new ActivityIngestor({
    events: {
      insert: (event) => eventRepository.insert(event),
      update: (id, changes) => database.events.update(id, changes),
    },
    preferences,
    diagnostics,
    rejections: createRejectionCounter(),
    metricSource,
    broadcast: broadcastToOverlays,
    health: { record: recordPipelineHealth },
  });

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
    }
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
    const [snapshot, tabs] = await Promise.all([
      Promise.resolve(connectionState.snapshot()),
      browser.tabs.query({ url: FOMO_TAB_URL_PATTERNS }),
    ]);

    return {
      ok: true,
      connected: snapshot.connected,
      authenticated: snapshot.authenticated,
      hasFomoTab: tabs.length > 0,
    };
  };

  const handlePipelineHealthQuery = async (): Promise<PipelineHealthQueryResponse> => ({
    ok: true,
    health: await pipelineHealth.snapshot(),
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

  const bootstrap = async (): Promise<void> => {
    await configureActionSidePanel().catch(() => {
      diagnostics.record({
        code: 'storage_failure',
        messageType: 'sidepanel.bootstrap',
      });
    });

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

    // Seed the suppression cache so the FIRST event's toast flag already
    // reflects stored settings and annotations.
    await ingestor.warmSuppression();

    await retentionScheduler.seed();
    await retentionScheduler.maybeRun();
    await refreshBadge();
  };

  void bootstrap().catch(recordStorageFailure);

  browser.runtime.onMessage.addListener(
    (rawMessage: unknown, sender: SenderForGuard) => {
      const parsed = parseExtensionMessage(rawMessage);

      if (!parsed.ok) {
        return undefined;
      }

      const message = parsed.message;

      if (!isTrustedSenderForMessage(toSenderLike(sender), message.type, browser.runtime.id)) {
        return undefined;
      }

      switch (message.type) {
        case 'activity.ingest':
          void ingestActivity(message.payload).catch(recordStorageFailure);
          void retentionScheduler.maybeRun().catch(recordStorageFailure);
          return undefined;
        case 'activity.broadcast':
          // Outbound-only worker -> overlay message; the sender guard above
          // already rejected it (trustClassForMessageType returns null), so
          // this branch is unreachable and exists only for exhaustiveness.
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
          // Settings/annotations feed the ingest suppression cache: refresh
          // it so the next event's toast flag uses the new preferences.
          void ingestor.warmSuppression().catch(recordStorageFailure);

          return undefined;
      }
    },
  );
});
