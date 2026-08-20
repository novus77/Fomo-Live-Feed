import type { TradeEventV1 } from '../src/domain/activity';
import type { BrowserActionLike } from '../src/background/badge';
import {
  nextBadgeCheckDelay,
  refreshBadge as refreshBadgeFromStorage,
} from '../src/background/badge-refresh';
import {
  ConnectionStateMachine,
  readLastConnectionAt,
  writeLastConnectionAt,
  type SessionStorageLike,
} from '../src/background/connection-state';
import { DiagnosticRecorder } from '../src/background/diagnostics';
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
  isTrustedSenderForMessage,
  type MessageSenderLike,
} from '../src/messaging/guards';
import {
  parseExtensionMessage,
  type EventQuery,
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
  tab?: { url?: string | undefined };
}

const toSenderLike = (sender: SenderForGuard): MessageSenderLike => ({
  ...(sender.id !== undefined ? { id: sender.id } : {}),
  ...(sender.url !== undefined ? { url: sender.url } : {}),
  ...(sender.tab?.url !== undefined ? { tab: { url: sender.tab.url } } : {}),
});

export default defineBackground(() => {
  const database = new FomoFeedDatabase();
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
  const connectionState = new ConnectionStateMachine({ now: () => Date.now() });

  const recordStorageFailure = (): void => {
    diagnostics.record({ code: 'storage_failure', messageType: 'background' });
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
  });

  // Bounded badge re-check: a one-shot armed from the persisted report time
  // so a quiet page flips the badge to gray right after the 30-second stale
  // boundary without any further events. A pending timer cannot keep an MV3
  // service worker alive; if the worker is suspended first, bootstrap
  // re-derives the color from the persisted timestamp.
  let badgeCheckTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleBadgeRefresh = (lastConnectionAt: number | undefined): void => {
    if (badgeCheckTimer !== null) {
      clearTimeout(badgeCheckTimer);
      badgeCheckTimer = null;
    }

    const delay = nextBadgeCheckDelay(lastConnectionAt, Date.now());

    if (delay === null) {
      return;
    }

    badgeCheckTimer = setTimeout(() => {
      badgeCheckTimer = null;
      void refreshBadge().catch(recordStorageFailure);
    }, delay);
  };

  // The badge phase is recomputed from the PERSISTED last-report timestamp
  // (chrome.storage.session) on every refresh, so it can never be stuck on
  // stale in-memory state (SHOULD-FIX 6).
  const refreshBadge = async (): Promise<void> => {
    const lastConnectionAt = await refreshBadgeFromStorage({
      action,
      storage: sessionStorage,
      unreadCount: () => eventRepository.unreadCount(),
      now: () => Date.now(),
    });

    scheduleBadgeRefresh(lastConnectionAt);
  };

  const ingestActivity = async (payload: unknown): Promise<void> => {
    const outcome = await ingestor.ingest({ payload, receivedAt: Date.now() });

    if (outcome.status === 'inserted') {
      await refreshBadge();
    }
  };

  const handleConnectionChanged = async (payload: {
    connected: boolean;
    at: number;
  }): Promise<void> => {
    if (payload.connected) {
      connectionState.reportConnected(payload.at);
    } else {
      connectionState.reportDisconnected(payload.at);
    }

    // Persist the last bridge report so a restarted worker can re-seed the
    // machine AND the badge phase; session storage is ephemeral and never
    // part of event history.
    await writeLastConnectionAt(sessionStorage, payload.at);
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
    const lastConnectionAt = await readLastConnectionAt(sessionStorage);

    if (lastConnectionAt !== undefined) {
      connectionState.reportConnected(lastConnectionAt);
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
        case 'connection.changed':
          void handleConnectionChanged(message.payload).catch(recordStorageFailure);
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
        case 'preferences.changed':
          // Settings/annotations feed the ingest suppression cache: refresh
          // it so the next event's toast flag uses the new preferences.
          void ingestor.warmSuppression().catch(recordStorageFailure);

          return undefined;
      }
    },
  );
});