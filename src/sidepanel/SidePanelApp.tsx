import { useCallback, useEffect, useMemo, useState } from 'react';

import type { TradeEventV1 } from '../domain/activity';
import type {
  TraderAnnotationUpdate,
  TraderAnnotationV1,
} from '../domain/annotations';
import {
  DEFAULT_SETTINGS,
  type LocalSettingsV1,
  type MetricKey,
} from '../domain/settings';
import { parseExtensionMessage } from '../messaging/protocol';
import { ConnectionIndicator } from './ConnectionIndicator';
import { needsFomoRefresh } from './pipeline-health-view';
import {
  ANNOTATIONS_STORAGE_KEY,
  LocalPreferences,
  SETTINGS_STORAGE_KEY,
} from '../storage/local-preferences';
import type { EventPageQuery } from '../storage/event-repository';
import { ConnectionBanner } from '../popup/ConnectionBanner';
import {
  DEFAULT_FILTERS,
  popupConnectionState,
  type PopupConnectionState,
  type PopupEventFilters,
} from '../popup/event-query';
import { FilterBar } from '../popup/FilterBar';
import { HistoryFeed } from '../popup/HistoryFeed';
import {
  markEventsRead,
  notifyPreferencesChanged,
  queryConnection,
  queryEvents,
  queryPipelineHealth,
  type PopupRuntimeLike,
  type PopupStorageLike,
} from '../popup/popup-io';
import { SettingsPanel } from '../popup/SettingsPanel';
import { useEventFeed } from '../popup/use-event-feed';

/**
 * Bounded connection re-query schedule (SHOULD-FIX 8): while the panel stays
 * open, re-evaluate the worker's connection verdict on this interval so the
 * panel and the toolbar badge cannot drift apart.
 */
const CONNECTION_REQUERY_INTERVAL_MS = 30_000;

/**
 * Persistent side-panel composition root.
 *
 * entrypoints/sidepanel/App.tsx injects the real browser APIs; this component
 * is the unit-testable root. It owns:
 *
 * - connection state (connection.query + live connection.changed refreshes +
 *   a bounded re-query schedule so panel and badge cannot disagree while the
 *   panel stays open - SHOULD-FIX 8);
 * - settings/annotations (LocalPreferences + injected chrome.storage.onChanged);
 * - the paginated searchable feed (useEventFeed);
 * - annotation and metric mutations, each followed by preferences.changed
 *   so the worker's toast-suppression cache refreshes immediately.
 *
 * Exactly four top-level states are rendered: login-required, Fomo tab
 * offline, connected-empty, and connected-with-history.
 */

export interface SidePanelDependencies {
  runtime: PopupRuntimeLike;
  storage: PopupStorageLike;
  now: () => number;
  openLink?: (url: URL) => void;
  copyText?: (text: string) => Promise<void>;
}

export function SidePanelApp(props: { deps: SidePanelDependencies }) {
  const { deps } = props;
  const runtime = deps.runtime;
  const now = deps.now;

  const preferences = useMemo(
    () => new LocalPreferences(deps.storage.local),
    [deps.storage.local],
  );

  const openLink =
    deps.openLink ??
    ((url: URL) => {
      window.open(url.href, '_blank', 'noopener,noreferrer');
    });
  const copyText =
    deps.copyText ?? ((text: string) => navigator.clipboard.writeText(text));

  // NIT: start in an explicit loading state so the popup never flashes
  // 'offline' before connection.query resolves.
  const [connectionState, setConnectionState] =
    useState<PopupConnectionState>('loading');
  const [settings, setSettings] = useState<LocalSettingsV1>(DEFAULT_SETTINGS);
  const [annotations, setAnnotations] = useState<
    ReadonlyMap<string, TraderAnnotationV1>
  >(new Map());
  const [filters, setFilters] = useState<PopupEventFilters>(DEFAULT_FILTERS);
  const [pinnedFirst, setPinnedFirst] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showRefreshGuidance, setShowRefreshGuidance] = useState(false);

  // Connection state: query the worker on mount, re-query whenever the
  // bridge reports a change while the popup is open, AND re-query on a
  // bounded schedule (SHOULD-FIX 8) so a state that changed without an event
  // reaching the open popup cannot leave popup and badge disagreeing.
  useEffect(() => {
    let disposed = false;
    let latestRequest = 0;

    const refreshConnection = async (): Promise<void> => {
      const request = ++latestRequest;

      try {
        const [response, healthResponse] = await Promise.all([
          queryConnection(runtime),
          queryPipelineHealth(runtime).catch(() => undefined),
        ]);

        if (!disposed && request === latestRequest) {
          setConnectionState(
            popupConnectionState({
              connected: response.connected,
              authenticated: response.authenticated,
              hasFomoTab: response.hasFomoTab,
            }),
          );
          setShowRefreshGuidance(
            healthResponse !== undefined && needsFomoRefresh({
              hasFomoTab: response.hasFomoTab,
              observerInstalled: healthResponse.health.observerInstalled,
              socketObserved: healthResponse.health.socketObserved,
              connected: response.connected,
            }),
          );
        }
      } catch {
        if (!disposed && request === latestRequest) {
          setConnectionState('offline');
          setShowRefreshGuidance(false);
        }
      }
    };

    void refreshConnection();

    const onMessage = (message: unknown): void => {
      const parsed = parseExtensionMessage(message);

      if (parsed.ok && parsed.message.type === 'connection.changed') {
        void refreshConnection();
      }
    };

    runtime.onMessage.addListener(onMessage);

    const pollId = setInterval(() => {
      void refreshConnection();
    }, CONNECTION_REQUERY_INTERVAL_MS);

    return () => {
      disposed = true;
      latestRequest += 1;
      runtime.onMessage.removeListener(onMessage);
      clearInterval(pollId);
    };
  }, [runtime]);

  // Settings + annotations: load on mount and re-read on every
  // chrome.storage.onChanged so edits made anywhere propagate immediately.
  useEffect(() => {
    let disposed = false;

    const reload = async (): Promise<void> => {
      const [nextSettings, nextAnnotations] = await Promise.all([
        preferences.getSettings(),
        preferences.listAnnotations(),
      ]);

      if (disposed) {
        return;
      }

      setSettings(nextSettings);
      setAnnotations(
        new Map(nextAnnotations.map((annotation) => [annotation.traderId, annotation])),
      );
    };

    void reload();

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
        void reload();
      }
    };

    deps.storage.onChanged.addListener(onStorageChanged);

    return () => {
      disposed = true;
      deps.storage.onChanged.removeListener(onStorageChanged);
    };
  }, [preferences, deps.storage.onChanged]);

  // Feed: DB-executed filters + popup-side search/action + read marking.
  const fetchPage = useCallback(
    (query: EventPageQuery) => queryEvents(runtime, query),
    [runtime],
  );
  const markRead = useCallback(
    (ids: readonly string[], at: number) => markEventsRead(runtime, ids, at),
    [runtime],
  );

  const feed = useEventFeed(filters, pinnedFirst, {
    fetchPage,
    markRead,
    annotations,
    now,
    // BLOCKING 1: only a CONNECTED popup may mark rendered rows read. In the
    // offline / login-required / reconnecting states the same rows render
    // READ-ONLY below the banner and nothing is ever marked read.
    readEnabled: connectionState === 'connected',
  });

  const upsertAnnotation = useCallback(
    (traderId: string, update: TraderAnnotationUpdate): void => {
      void preferences
        .upsertAnnotation(traderId, update, now())
        .then((next) => {
          setAnnotations((prev) => new Map(prev).set(traderId, next));
          notifyPreferencesChanged(runtime);
        })
        .catch(() => {});
    },
    [preferences, runtime, now],
  );

  const deleteAnnotation = useCallback(
    (traderId: string): void => {
      void preferences
        .deleteAnnotation(traderId, now())
        .then(() => {
          setAnnotations((prev) => {
            const next = new Map(prev);

            next.delete(traderId);

            return next;
          });
          notifyPreferencesChanged(runtime);
        })
        .catch(() => {});
    },
    [preferences, runtime, now],
  );

  const updateMetrics = useCallback(
    (metrics: { primary?: MetricKey; secondary?: MetricKey }): void => {
      void preferences
        .updateSettings({ metrics })
        .then((next) => {
          setSettings(next);
          notifyPreferencesChanged(runtime);
        })
        .catch(() => {});
    },
    [preferences, runtime],
  );

  return (
    <div className="sidepanel-root">
      <header className="sidepanel-header">
        <div className="sidepanel-heading">
          <h1 className="sidepanel-title">Fomo Live Feed</h1>
          <ConnectionIndicator state={connectionState} />
        </div>
        <button
          type="button"
          className="sidepanel-settings-toggle"
          aria-label="Settings"
          title="Settings"
          aria-expanded={showSettings}
          onClick={() => {
            setShowSettings((visible) => !visible);
          }}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
            <path
              fill="currentColor"
              d="M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.08-.98l2.11-1.65-2-3.46-2.49 1a7.3 7.3 0 0 0-1.69-.98L15 3.27h-4l-.4 2.66c-.61.25-1.17.58-1.69.98l-2.49-1-2 3.46 2.11 1.65a6.7 6.7 0 0 0 0 1.96l-2.11 1.65 2 3.46 2.49-1c.52.4 1.08.73 1.69.98l.4 2.66h4l.4-2.66c.61-.25 1.17-.58 1.69-.98l2.49 1 2-3.46-2.15-1.65ZM13 15.5A3.5 3.5 0 1 1 13 8a3.5 3.5 0 0 1 0 7.5Z"
            />
          </svg>
        </button>
      </header>

      {connectionState === 'login-required' && !showRefreshGuidance && (
        <ConnectionBanner state="login-required" openLink={openLink} />
      )}
      {connectionState === 'reconnecting' && <ConnectionBanner state="reconnecting" />}
      {connectionState === 'offline' && <ConnectionBanner state="offline" />}
      {showRefreshGuidance && (
        <ConnectionBanner state="refresh-required" openLink={openLink} />
      )}

      {connectionState !== 'loading' && (
        <div className="popup-feed">
          <FilterBar
            filters={filters}
            onChange={setFilters}
            pinnedFirst={pinnedFirst}
            onPinnedFirstChange={setPinnedFirst}
            traders={feed.traders}
            tokens={feed.tokens}
          />
          <HistoryFeed
            events={feed.events}
            status={feed.status}
            hasMore={feed.hasMore}
            loadingMore={feed.loadingMore}
            scanExceeded={feed.scanExceeded}
            settings={settings}
            annotations={annotations}
            now={now}
            copyText={copyText}
            openLink={openLink}
            onLoadMore={feed.loadMore}
            onRetry={feed.retry}
            onUpsertAnnotation={upsertAnnotation}
            onDeleteAnnotation={deleteAnnotation}
          />
        </div>
      )}

      {showSettings && (
        <SettingsPanel settings={settings} onChange={updateMetrics} />
      )}
    </div>
  );
}
