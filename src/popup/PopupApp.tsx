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
import {
  ANNOTATIONS_STORAGE_KEY,
  LocalPreferences,
  SETTINGS_STORAGE_KEY,
} from '../storage/local-preferences';
import type { EventPageQuery } from '../storage/event-repository';
import { ConnectionBanner } from './ConnectionBanner';
import {
  DEFAULT_FILTERS,
  popupConnectionState,
  type PopupConnectionState,
  type PopupEventFilters,
} from './event-query';
import { FilterBar } from './FilterBar';
import { HistoryFeed } from './HistoryFeed';
import {
  markEventsRead,
  notifyPreferencesChanged,
  queryConnection,
  queryEvents,
  type PopupRuntimeLike,
  type PopupStorageLike,
} from './popup-io';
import { SettingsPanel } from './SettingsPanel';
import { useEventFeed } from './use-event-feed';

/**
 * Bounded connection re-query schedule (SHOULD-FIX 8): while the popup stays
 * open, re-evaluate the worker's connection verdict on this interval so the
 * popup and the toolbar badge cannot drift apart.
 */
const CONNECTION_REQUERY_INTERVAL_MS = 30_000;

/**
 * Popup composition root (plan Task 9/10).
 *
 * entrypoints/popup/App.tsx stays a thin wrapper that injects the real
 * browser APIs; this component is the unit-testable root. It owns:
 *
 * - connection state (connection.query + live connection.changed refreshes +
 *   a bounded re-query schedule so popup and badge cannot disagree while the
 *   popup stays open - SHOULD-FIX 8);
 * - settings/annotations (LocalPreferences + injected chrome.storage.onChanged);
 * - the paginated searchable feed (useEventFeed);
 * - annotation and metric mutations, each followed by preferences.changed
 *   so the worker's toast-suppression cache refreshes immediately.
 *
 * Exactly four top-level states are rendered: login-required, Fomo tab
 * offline, connected-empty, and connected-with-history.
 */

export interface PopupDependencies {
  runtime: PopupRuntimeLike;
  storage: PopupStorageLike;
  now: () => number;
  openLink?: (url: URL) => void;
  copyText?: (text: string) => Promise<void>;
}

export function PopupApp(props: { deps: PopupDependencies }) {
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

  // Connection state: query the worker on mount, re-query whenever the
  // bridge reports a change while the popup is open, AND re-query on a
  // bounded schedule (SHOULD-FIX 8) so a state that changed without an event
  // reaching the open popup cannot leave popup and badge disagreeing.
  useEffect(() => {
    let disposed = false;

    const refreshConnection = async (): Promise<void> => {
      try {
        const response = await queryConnection(runtime);

        if (!disposed) {
          setConnectionState(
            popupConnectionState({
              connected: response.connected,
              authenticated: response.authenticated,
              hasFomoTab: response.hasFomoTab,
            }),
          );
        }
      } catch {
        if (!disposed) {
          setConnectionState('offline');
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
    <div className="popup-root">
      <header className="popup-header">
        <h1 className="popup-title">Fomo Live Feed</h1>
        <button
          type="button"
          className="popup-settings-toggle"
          aria-expanded={showSettings}
          onClick={() => {
            setShowSettings((visible) => !visible);
          }}
        >
          Settings
        </button>
      </header>

      {connectionState === 'login-required' && (
        <ConnectionBanner state="login-required" openLink={openLink} />
      )}
      {connectionState === 'reconnecting' && <ConnectionBanner state="reconnecting" />}
      {connectionState === 'offline' && <ConnectionBanner state="offline" />}

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
