import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import type { TradeEventV1 } from '../domain/activity';
import type { PipelineHealthSnapshotV1 } from '../background/pipeline-health';
import type { ActivitySyncState } from '../background/activity-sync';
import type {
  TraderAnnotationUpdate,
  TraderAnnotationV1,
} from '../domain/annotations';
import {
  DEFAULT_SETTINGS,
  type DisplayMode,
  type LocalSettingsV6,
  type LocalSettingsUpdate,
  type UiTheme,
} from '../domain/settings';
import { useLocale } from '../i18n/LocaleProvider';
import { parseExtensionMessage } from '../messaging/protocol';
import type { SurfaceKey } from '../messaging/protocol';
import { createContentTranslationClient } from '../translation/content-translation-client';
import { OpinionTranslationCoordinator } from '../translation/opinion-translation';
import { ConnectionIndicator } from './ConnectionIndicator';
import { FeedFilterPopover } from './FeedFilterPopover';
import { RefreshButton } from './RefreshButton';
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
  activeFilterCount,
  activeSidePanelFilterGroupCount,
  normalizeSearchTerm,
  popupConnectionState,
  type PopupConnectionState,
  type PopupEventFilters,
} from '../popup/event-query';
import { HistoryFeed } from '../popup/HistoryFeed';
import { FilterToolbar } from '../popup/FilterToolbar';
import {
  markEventsRead,
  notifyPreferencesChanged,
  queryActivitySync,
  queryConnection,
  queryEvents,
  queryPipelineHealth,
  requestActivitySync,
  type PopupRuntimeLike,
  type PopupStorageLike,
} from '../popup/popup-io';
import { SettingsPanel } from '../popup/SettingsPanel';
import { useEventFeed } from '../popup/use-event-feed';
import { PipelineDiagnostics } from './PipelineDiagnostics';
import { SupportPanel } from './SupportPanel';
import {
  createSurfaceSwitchClient,
  type SurfaceSwitchClient,
} from './surface-switch-client';
import { useSurfaceReady } from './use-surface-ready';
import {
  FILTERABLE_CHAINS,
  toMutedChains,
  toVisibleChains,
} from './chain-visibility';

/**
 * Bounded connection re-query schedule (SHOULD-FIX 8): while the panel stays
 * open, re-evaluate the worker's connection verdict on this interval so the
 * panel and the toolbar badge cannot drift apart.
 */
const CONNECTION_REQUERY_INTERVAL_MS = 30_000;
const HEALTH_REQUERY_INTERVAL_MS = 30_000;
const HEALTH_CHANGE_DEBOUNCE_MS = 50;
const RELATIVE_TIME_TICK_MS = 1_000;

/**
 * Task 5: a panel that opens (or becomes) connected with no recovery success
 * in the last 5 minutes may be showing a cached feed that missed events; ask
 * the worker for ONE bounded backfill per mount (stale-panel-open).
 */
const STALE_PANEL_SYNC_MS = 5 * 60 * 1_000;

type OpenUtilityPanel = 'filters' | 'settings' | 'support' | null;

/** The last completed recovery success, or undefined when none is known. */
const lastSyncSuccessAt = (state: ActivitySyncState): number | undefined => {
  switch (state.status) {
    case 'updated':
    case 'current':
      return state.finishedAt;
    case 'idle':
      return state.lastSucceededAt;
    default:
      return undefined;
  }
};

/** True when the panel's cached feed may be stale (no success, or too old). */
const isSyncStale = (state: ActivitySyncState, at: number): boolean => {
  const lastSuccess = lastSyncSuccessAt(state);

  return lastSuccess === undefined || at - lastSuccess > STALE_PANEL_SYNC_MS;
};

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
 *   so extension consumers can observe the persisted preference update.
 *
 * Exactly four top-level states are rendered: login-required, Fomo tab
 * offline, connected-empty, and connected-with-history.
 */

export interface SidePanelDependencies {
  runtime: PopupRuntimeLike;
  storage: PopupStorageLike;
  /**
   * The settings surface created by entrypoints/sidepanel/App.tsx and shared
   * with the LocaleProvider that wraps this component, so the panel never
   * constructs a second LocalPreferences instance. When omitted (legacy
   * compatibility wrapper / direct tests), this component builds its own
   * from `storage.local`.
   */
  preferences?: LocalPreferences;
  now: () => number;
  openLink?: (url: URL) => void;
  copyText?: (text: string) => Promise<void>;
  getCurrentWindowId?: () => Promise<number>;
  /**
   * `popup` keeps the search/filter toolbar and pinned-first toggle that the
   * deprecated popup wrapper still needs; `sidepanel` (default) renders a
   * controls-free feed.
   */
  variant?: 'sidepanel' | 'popup';
  /**
   * Which surface hosts the panel. `floatpanel` enables the geometry
   * reporter (persists the window size/position so the single global float
   * window restores it on the next open). Defaults to `sidepanel`, which
   * reports nothing.
   */
  surface?: 'sidepanel' | 'floatpanel' | 'pip';
  /**
   * Whether this mounted feed owns read receipts. Defaults to true. The
   * floating host disables ownership while its PiP child is mounted so the
   * visually overlapping feeds cannot both mark the same row.
   */
  readEnabled?: boolean;
}

export interface SidePanelAppProps {
  deps: SidePanelDependencies;
  surfaceSwitchClient?: SurfaceSwitchClient;
  surfaceLifecycleEnabled?: boolean;
  /** Reports the installed initial feed snapshot exactly once per mount. */
  onFeedReady?: (eventWatermark: number) => void;
}

export function SidePanelApp(props: SidePanelAppProps) {
  const { deps, onFeedReady } = props;
  const runtime = deps.runtime;
  const now = deps.now;
  const variant = deps.variant ?? 'sidepanel';
  const surface = deps.surface ?? 'sidepanel';
  const surfaceKey: SurfaceKey = surface === 'sidepanel' ? 'sidepanel' : 'floating';
  const showFeedControls = variant === 'popup';
  const { translate } = useLocale();

  // Prefer the shared instance injected by App.tsx; fall back to building one
  // from the injected storage area (legacy compatibility wrapper, direct
  // tests).
  const preferences = useMemo(
    () => deps.preferences ?? new LocalPreferences(deps.storage.local),
    [deps.preferences, deps.storage.local],
  );
  const surfaceSwitchClient = useMemo(
    () => props.surfaceSwitchClient ?? createSurfaceSwitchClient(runtime, now),
    [now, props.surfaceSwitchClient, runtime],
  );
  const [surfaceSwitchState, setSurfaceSwitchState] = useState<
    'idle' | 'switching' | 'error'
  >('idle');

  const [translationRetryToken, setTranslationRetryToken] = useState(0);
  const [translationHostEpoch, setTranslationHostEpoch] = useState(0);

  useEffect(() => {
    const onMessage = (message: unknown): void => {
      const parsed = parseExtensionMessage(message);
      if (parsed.ok && parsed.message.type === 'translation.ready') {
        setTranslationRetryToken((value) => value + 1);
      }
      if (parsed.ok && parsed.message.type === 'translation.hostReady') {
        setTranslationHostEpoch((value) => value + 1);
      }
    };
    runtime.onMessage.addListener(onMessage);
    return () => runtime.onMessage.removeListener(onMessage);
  }, [runtime]);

  // One content-script facade for the whole side panel. The actual Chrome
  // Translator session lives in the Fomo isolated content script, where page
  // gestures can authorize model installation. No opinion text leaves the
  // local browser translation path.
  const translationApi = useMemo(
    () => createContentTranslationClient(
      runtime,
      `panel-${Math.random().toString(36).slice(2)}`,
    ),
    [runtime],
  );

  // ONE on-device translation coordinator for the whole side panel (plan Task
  // 7, session-leak fix): created once per mount and shared by every thesis
  // card, so N cards never hold N live translator sessions. The panel root
  // owns it and destroys it exactly once, when the panel unmounts — cards
  // never destroy it.
  const translationCoordinator = useMemo(
    () =>
      new OpinionTranslationCoordinator({
        api: translationApi,
        browserLanguage: () => navigator.language,
      }),
    [translationApi, translationHostEpoch],
  );

  useEffect(() => {
    return () => {
      translationCoordinator.destroy();
    };
  }, [translationCoordinator]);

  const openLink =
    deps.openLink ??
    ((url: URL) => {
      window.open(url.href, '_blank', 'noopener,noreferrer');
    });
  const copyText =
    deps.copyText ?? ((text: string) => navigator.clipboard.writeText(text));
  const openToken = useCallback((target: Pick<TradeEventV1, 'chain' | 'tokenAddress'>) => {
    void runtime.sendMessage({
      protocolVersion: 1,
      type: 'navigation.openToken',
      payload: target,
    }).catch(() => {});
  }, [runtime]);

  // Float surface only: report the window geometry (throttled) so the worker
  // persists it and restores the user's size/position on the next open.
  useEffect(() => {
    if (surface !== 'floatpanel') {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const report = (): void => {
      const payload: { width: number; height: number; left?: number; top?: number } = {
        width: Math.max(1, Math.round(window.outerWidth)),
        height: Math.max(1, Math.round(window.outerHeight)),
      };
      if (Number.isFinite(window.screenX)) {
        payload.left = Math.round(window.screenX);
      }
      if (Number.isFinite(window.screenY)) {
        payload.top = Math.round(window.screenY);
      }
      void runtime.sendMessage({
        protocolVersion: 1,
        type: 'float.geometryChanged',
        payload,
      }).catch(() => {});
    };
    const schedule = (): void => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        report();
      }, 400);
    };

    window.addEventListener('resize', schedule);
    // Report once on mount so a freshly opened window's geometry is recorded.
    schedule();

    return () => {
      clearTimeout(timer);
      window.removeEventListener('resize', schedule);
    };
  }, [surface, runtime]);

  // NIT: start in an explicit loading state so the popup never flashes
  // 'offline' before connection.query resolves.
  const [connectionState, setConnectionState] =
    useState<PopupConnectionState>('loading');
  const [settings, setSettings] = useState<LocalSettingsV6>(DEFAULT_SETTINGS);
  const [annotations, setAnnotations] = useState<
    ReadonlyMap<string, TraderAnnotationV1>
  >(new Map());
  const [filters, setFilters] = useState<PopupEventFilters>(DEFAULT_FILTERS);
  const filtersRef = useRef<PopupEventFilters>(DEFAULT_FILTERS);
  const pendingChainWritesRef = useRef(0);
  const chainPersistenceFailureReportedRef = useRef(false);
  const [pinnedFirst, setPinnedFirst] = useState(false);
  const [openUtilityPanel, setOpenUtilityPanel] =
    useState<OpenUtilityPanel>(null);
  const [showRefreshGuidance, setShowRefreshGuidance] = useState(false);
  const [connectionBannerSettled, setConnectionBannerSettled] = useState(false);
  const [pipelineHealth, setPipelineHealth] = useState<PipelineHealthSnapshotV1>();
  const [connectionHealthContext, setConnectionHealthContext] = useState<{
    hasFomoTab: boolean;
    connected: boolean;
  }>();
  const [diagnosticsNow, setDiagnosticsNow] = useState(() => now());
  // Task 5: the worker's recovery coordinator state, queried on mount and
  // re-queried on every sync.changed broadcast.
  const [syncState, setSyncState] = useState<ActivitySyncState>();
  const staleSyncRequestedRef = useRef(false);
  const connectionGraceTargetRef = useRef<PopupConnectionState | undefined>(undefined);
  const refreshConnectionRef = useRef<() => Promise<PopupConnectionState | undefined>>(
    async () => undefined,
  );

  // Connection state: query the worker on mount, re-query whenever the
  // bridge reports a change while the popup is open, AND re-query on a
  // bounded schedule (SHOULD-FIX 8) so a state that changed without an event
  // reaching the open popup cannot leave popup and badge disagreeing.
  useEffect(() => {
    let disposed = false;
    let latestRequest = 0;

    const refreshConnection = async (): Promise<PopupConnectionState | undefined> => {
      const request = ++latestRequest;

      try {
        const response = await queryConnection(runtime);

        if (!disposed && request === latestRequest) {
          const nextState = popupConnectionState({
            connected: response.connected,
            authenticated: response.authenticated,
            hasFomoTab: response.hasFomoTab,
          });
          setConnectionState(nextState);
          setConnectionHealthContext({
            hasFomoTab: response.hasFomoTab,
            connected: response.connected,
          });
          if (connectionGraceTargetRef.current === nextState) {
            setConnectionBannerSettled(true);
          }
          return nextState;
        }
      } catch {
        if (!disposed && request === latestRequest) {
          setConnectionState('offline');
          setShowRefreshGuidance(false);
          return 'offline';
        }
      }

      return undefined;
    };

    refreshConnectionRef.current = refreshConnection;
    void refreshConnection();

    const onMessage = (message: unknown): void => {
      const parsed = parseExtensionMessage(message);

      if (parsed.ok && parsed.message.type === 'connection.changed') {
        void refreshConnection();

        // Task 5: mirror the worker's reconnect backfill trigger so the
        // panel's own recovery state reflects the reconnect immediately
        // (the coordinator is single-flight, so a request racing the
        // worker's own reconnect run is a no-op).
        if (parsed.message.payload.connected && parsed.message.payload.authenticated) {
          void requestActivitySync(runtime, 'reconnect')
            .then(setSyncState)
            .catch(() => {});
        }
      }
    };

    runtime.onMessage.addListener(onMessage);

    const pollId = setInterval(() => {
      void refreshConnection();
    }, CONNECTION_REQUERY_INTERVAL_MS);

    return () => {
      disposed = true;
      latestRequest += 1;
      if (refreshConnectionRef.current === refreshConnection) {
        refreshConnectionRef.current = async () => undefined;
      }
      runtime.onMessage.removeListener(onMessage);
      clearInterval(pollId);
    };
  }, [runtime]);

  useEffect(() => {
    let disposed = false;
    let latestRequest = 0;
    let inFlight = false;
    let dirty = false;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const refreshHealth = async (): Promise<void> => {
      if (inFlight) {
        dirty = true;
        return;
      }

      inFlight = true;
      const request = ++latestRequest;
      try {
        const response = await queryPipelineHealth(runtime);
        if (!disposed && request === latestRequest) {
          setPipelineHealth(response.health);
        }
      } catch {
        // Keep the last known safe snapshot; the bounded poll retries.
      } finally {
        inFlight = false;
        if (!disposed && dirty) {
          dirty = false;
          void refreshHealth();
        }
      }
    };

    const scheduleHealthRefresh = (): void => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        void refreshHealth();
      }, HEALTH_CHANGE_DEBOUNCE_MS);
    };

    void refreshHealth();
    const onMessage = (message: unknown): void => {
      const parsed = parseExtensionMessage(message);
      if (parsed.ok && parsed.message.type === 'pipeline.healthChanged') {
        scheduleHealthRefresh();
      }
    };
    runtime.onMessage.addListener(onMessage);
    const pollId = setInterval(() => { void refreshHealth(); }, HEALTH_REQUERY_INTERVAL_MS);

    return () => {
      disposed = true;
      latestRequest += 1;
      runtime.onMessage.removeListener(onMessage);
      clearInterval(pollId);
      clearTimeout(debounceTimer);
    };
  }, [runtime]);

  // Task 5: recovery state — query the coordinator on mount and re-query on
  // every sync.changed broadcast (the worker emits one on every state
  // transition, so the panel never polls).
  useEffect(() => {
    let disposed = false;
    let latestRequest = 0;

    const refreshSync = async (): Promise<void> => {
      const request = ++latestRequest;

      try {
        const state = await queryActivitySync(runtime);

        if (!disposed && request === latestRequest) {
          setSyncState(state);
        }
      } catch {
        // Keep the last known state; the next sync.changed re-queries.
      }
    };

    void refreshSync();

    const onMessage = (message: unknown): void => {
      const parsed = parseExtensionMessage(message);

      if (parsed.ok && parsed.message.type === 'sync.changed') {
        void refreshSync();
      }
    };

    runtime.onMessage.addListener(onMessage);

    return () => {
      disposed = true;
      latestRequest += 1;
      runtime.onMessage.removeListener(onMessage);
    };
  }, [runtime]);

  // Task 5: when the panel is connected and the last successful recovery is
  // older than 5 minutes (or never happened), ask the worker for ONE bounded
  // backfill per mount so a cached feed cannot stay stale while the panel
  // sits open. The coordinator is single-flight, so this never duplicates a
  // reconnect backfill that raced it.
  useEffect(() => {
    if (staleSyncRequestedRef.current) {
      return;
    }

    if (connectionState !== 'connected' || syncState === undefined) {
      return;
    }

    if (!isSyncStale(syncState, now())) {
      return;
    }

    staleSyncRequestedRef.current = true;
    void requestActivitySync(runtime, 'stale-panel-open')
      .then(setSyncState)
      .catch(() => {});
  }, [connectionState, syncState, runtime, now]);

  useEffect(() => {
    if (connectionHealthContext === undefined || pipelineHealth === undefined) {
      return;
    }
    setShowRefreshGuidance(needsFomoRefresh({
      ...connectionHealthContext,
      observerInstalled: pipelineHealth.observerInstalled,
      socketObserved: pipelineHealth.socketObserved,
    }));
  }, [connectionHealthContext, pipelineHealth]);

  useEffect(() => {
    if (connectionState === 'connected' || connectionState === 'loading') {
      connectionGraceTargetRef.current = undefined;
      setConnectionBannerSettled(false);
      return undefined;
    }
    if (connectionState === 'offline') {
      connectionGraceTargetRef.current = undefined;
      setConnectionBannerSettled(true);
      return undefined;
    }

    connectionGraceTargetRef.current = undefined;
    setConnectionBannerSettled(false);
    const timer = setTimeout(() => {
      connectionGraceTargetRef.current = connectionState;
      void refreshConnectionRef.current();
    }, 600);
    return () => {
      if (connectionGraceTargetRef.current === connectionState) {
        connectionGraceTargetRef.current = undefined;
      }
      clearTimeout(timer);
    };
  }, [connectionState]);

  useEffect(() => {
    if (openUtilityPanel !== 'settings') return;
    setDiagnosticsNow(now());
    const tickId = setInterval(() => { setDiagnosticsNow(now()); }, RELATIVE_TIME_TICK_MS);
    return () => { clearInterval(tickId); };
  }, [openUtilityPanel, now]);

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
      if (pendingChainWritesRef.current === 0) {
        const visibleChains = toVisibleChains(nextSettings.filters.mutedChains);
        setFilters((current) => {
          const next = { ...current, visibleChains };
          filtersRef.current = next;
          return next;
        });
      }
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

  const feed = useEventFeed(
    filters,
    showFeedControls ? pinnedFirst : false,
    {
      fetchPage,
      markRead,
      annotations,
      now,
      eventsChanged: runtime.onMessage,
      // BLOCKING 1: only a CONNECTED side panel/popup may mark rendered rows
      // read. In the offline / login-required / reconnecting states the same
      // rows render READ-ONLY below the banner and nothing is ever marked read.
      readEnabled: connectionState === 'connected' && (deps.readEnabled ?? true),
    },
  );

  const feedEventsRef = useRef(feed.events);
  feedEventsRef.current = feed.events;
  const didReportFeedReadyRef = useRef(false);
  useEffect(() => {
    if (
      feed.status !== 'ready'
      || onFeedReady === undefined
      || didReportFeedReadyRef.current
    ) {
      return;
    }

    // useEventFeed installs its displayed snapshot in an effect after the
    // query resolves. Defer one task so the callback observes that committed
    // snapshot rather than the preceding loading render.
    const timer = setTimeout(() => {
      if (didReportFeedReadyRef.current) return;
      didReportFeedReadyRef.current = true;
      onFeedReady(feedEventsRef.current.reduce(
        (latest, event) => Math.max(latest, event.occurredAt),
        0,
      ));
    }, 0);

    return () => clearTimeout(timer);
  }, [feed.status, onFeedReady]);

  // The coordinator opens a new target surface. It acknowledges the active
  // transaction only after the initial history snapshot and live listener
  // are ready; the source remains visible until this completes.
  const eventWatermark = feed.events.reduce(
    (latest, event) => Math.max(latest, event.occurredAt),
    0,
  );
  useSurfaceReady({
    enabled: feed.status === 'ready' && props.surfaceLifecycleEnabled !== false,
    runtime,
    getCurrentWindowId: deps.getCurrentWindowId,
    surface: surfaceKey,
    eventWatermark,
    now,
    client: surfaceSwitchClient,
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

  const updateOpinionTranslation = useCallback(
    (update: Partial<LocalSettingsV6['opinionTranslation']>): void => {
      void preferences
        .updateSettings({ opinionTranslation: update })
        .then((next) => {
          setSettings(next);
          notifyPreferencesChanged(runtime);
        })
        .catch(() => {});
    },
    [preferences, runtime],
  );

  const updateTheme = useCallback(
    (uiTheme: UiTheme): void => {
      void preferences
        .updateSettings({ uiTheme })
        .then((next) => {
          setSettings(next);
          notifyPreferencesChanged(runtime);
        })
        .catch(() => {});
    },
    [preferences, runtime],
  );

  const updateNotifications = useCallback(
    (update: Partial<LocalSettingsV6['notifications']>): void => {
      void preferences
        .updateSettings({ notifications: update })
        .then((next) => {
          setSettings(next);
          notifyPreferencesChanged(runtime);
        })
        .catch(() => {});
    },
    [preferences, runtime],
  );

  const updateFinancialDisplay = useCallback(
    (update: NonNullable<LocalSettingsUpdate['financialDisplay']>): void => {
      void preferences
        .updateSettings({ financialDisplay: update })
        .then((next) => {
          setSettings(next);
          notifyPreferencesChanged(runtime);
        })
        .catch(() => {});
    },
    [preferences, runtime],
  );

  const updateDisplayMode = useCallback(
    (displayMode: DisplayMode): void => {
      if (displayMode === surfaceKey || surfaceSwitchState === 'switching') return;
      setSurfaceSwitchState('switching');
      void (deps.getCurrentWindowId?.() ?? Promise.resolve(0))
        .then((windowId) => surfaceSwitchClient.switchTo(surfaceKey, displayMode, windowId))
        .then((result) => {
          if (!result.ok) setSurfaceSwitchState('error');
        })
        .catch(() => setSurfaceSwitchState('error'));
    },
    [deps.getCurrentWindowId, surfaceKey, surfaceSwitchClient, surfaceSwitchState],
  );

  const handleFiltersChange = useCallback((nextFilters: PopupEventFilters): void => {
    const previousFilters = filtersRef.current;
    filtersRef.current = nextFilters;
    setFilters(nextFilters);

    const chainsChanged = previousFilters.visibleChains.length !== nextFilters.visibleChains.length
      || previousFilters.visibleChains.some(
        (chain) => !nextFilters.visibleChains.includes(chain),
      );

    if (!chainsChanged) {
      return;
    }

    pendingChainWritesRef.current += 1;
    const mutedChains = toMutedChains(nextFilters.visibleChains);

    void preferences
      .updateSettings({ filters: { mutedChains } })
      .then((nextSettings) => {
        pendingChainWritesRef.current -= 1;
        chainPersistenceFailureReportedRef.current = false;
        setSettings(nextSettings);
        notifyPreferencesChanged(runtime);
      })
      .catch(() => {
        pendingChainWritesRef.current -= 1;
        if (!chainPersistenceFailureReportedRef.current) {
          chainPersistenceFailureReportedRef.current = true;
          console.warn('[chain-filter] failed to persist chain visibility');
        }
      });
  }, [preferences, runtime]);

  // Task 5: explicit UI refresh — ask the worker for a bounded backfill and
  // adopt the state it reports back (single-flight on the worker).
  const handleManualRefresh = useCallback((): void => {
    void requestActivitySync(runtime, 'manual')
      .then(setSyncState)
      .catch(() => {});
  }, [runtime]);

  const handleFilterOpenChange = useCallback((open: boolean): void => {
    setOpenUtilityPanel(open ? 'filters' : null);
  }, []);

  const toggleUtilityPanel = (
    panel: Exclude<OpenUtilityPanel, null>,
  ): void => {
    setOpenUtilityPanel((current) => (current === panel ? null : panel));
  };

  const financialStyle = {
    '--buy-amount-font-size': `${settings.financialDisplay.buyAmount.fontSizePx}px`,
    '--buy-amount-color': settings.financialDisplay.buyAmount.color === 'theme'
      ? 'var(--ui-text)'
      : settings.financialDisplay.buyAmount.color,
    '--sell-amount-font-size': `${settings.financialDisplay.sellAmount.fontSizePx}px`,
    '--sell-amount-color': settings.financialDisplay.sellAmount.color === 'theme'
      ? 'var(--ui-text)'
      : settings.financialDisplay.sellAmount.color,
    '--market-cap-font-size': `${settings.financialDisplay.marketCap.fontSizePx}px`,
    '--market-cap-color': settings.financialDisplay.marketCap.color === 'theme'
      ? 'var(--ui-text-muted)'
      : settings.financialDisplay.marketCap.color,
  } as CSSProperties;
  const presentedConnectionState = !connectionBannerSettled && (
    connectionState === 'login-required' || connectionState === 'reconnecting'
  )
    ? 'loading'
    : connectionState;
  const hasActiveFilters = showFeedControls
    ? activeFilterCount(filters) > 0 || normalizeSearchTerm(filters.search).length > 0
    : activeSidePanelFilterGroupCount(filters) > 0;

  return (
    <div className="sidepanel-root" data-theme={settings.uiTheme} style={financialStyle}>
      <header className="sidepanel-header" data-ui-region="header">
        <div className="sidepanel-heading">
          <h1 className="sidepanel-title">{translate('header.title')}</h1>
          <ConnectionIndicator state={presentedConnectionState} />
        </div>
        <div className="sidepanel-header-controls" data-ui-region="toolbar">
          {!showFeedControls && (
            <FeedFilterPopover
              filters={filters}
              open={openUtilityPanel === 'filters'}
              onOpenChange={handleFilterOpenChange}
              onFiltersChange={handleFiltersChange}
            />
          )}
          <RefreshButton
            state={syncState ?? { status: 'idle' }}
            onRefresh={handleManualRefresh}
          />
          <button
            type="button"
            className="sidepanel-settings-toggle compact-icon-button"
            data-testid="settings-toggle"
            aria-label={translate('header.settings')}
            title={translate('header.settings')}
            aria-expanded={openUtilityPanel === 'settings'}
            onClick={() => {
              toggleUtilityPanel('settings');
            }}
            >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path
                fill="currentColor"
                d="M19.43 12.98c.04-.32.07-.65.07-.98s-.03-.66-.08-.98l2.11-1.65-2-3.46-2.49 1a7.3 7.3 0 0 0-1.69-.98L15 3.27h-4l-.4 2.66c-.61.25-1.17.58-1.69.98l-2.49-1-2 3.46 2.11 1.65a6.7 6.7 0 0 0 0 1.96l-2.11 1.65 2 3.46 2.49-1c.52.4 1.08.73 1.69.98l.4 2.66h4l.4-2.66c.61-.25 1.17-.58 1.69-.98l2.49 1 2-3.46-2.15-1.65ZM13 15.5A3.5 3.5 0 1 1 13 8a3.5 3.5 0 0 1 0 7.5Z"
              />
            </svg>
          </button>
          <button
            type="button"
            className="sidepanel-support-toggle compact-icon-button"
            aria-label={translate('header.support')}
            title={translate('header.support')}
            aria-expanded={openUtilityPanel === 'support'}
            onClick={() => {
              toggleUtilityPanel('support');
            }}
          >
            <span>{translate('header.support')}</span>
          </button>
        </div>
      </header>

      {connectionBannerSettled && connectionState === 'login-required' && !showRefreshGuidance && (
        <ConnectionBanner state="login-required" openLink={openLink} compact={feed.events.length > 0} />
      )}
      {connectionBannerSettled && connectionState === 'reconnecting' && (
        <ConnectionBanner state="reconnecting" compact={feed.events.length > 0} />
      )}
      {connectionState === 'offline' && <ConnectionBanner state="offline" compact={feed.events.length > 0} />}
      {connectionBannerSettled && showRefreshGuidance && (
        <ConnectionBanner state="refresh-required" openLink={openLink} compact={feed.events.length > 0} />
      )}

      <div className="popup-feed sidepanel-feed">
        {showFeedControls && (
          <FilterToolbar
            filters={filters}
            onFiltersChange={handleFiltersChange}
            pinnedFirst={pinnedFirst}
            onPinnedFirstChange={setPinnedFirst}
            traders={feed.traders}
            tokens={feed.tokens}
          />
        )}
        <HistoryFeed
          events={feed.events}
          status={feed.status}
          hasMore={feed.hasMore}
          loadingMore={feed.loadingMore}
          scanExceeded={feed.scanExceeded}
          noChainsSelected={filters.visibleChains.length === 0}
          hasActiveFilters={hasActiveFilters}
          settings={settings}
          annotations={annotations}
          now={now}
          copyText={copyText}
          openLink={openLink}
          onOpenToken={openToken}
          translationApi={translationApi}
          translationCoordinator={translationCoordinator}
          translationRetryToken={translationRetryToken}
          onLoadMore={feed.loadMore}
          onRetry={feed.retry}
          onSelectAllChains={() => handleFiltersChange({
            ...filters,
            visibleChains: [...FILTERABLE_CHAINS],
          })}
          onUpsertAnnotation={upsertAnnotation}
          onDeleteAnnotation={deleteAnnotation}
        />
      </div>

      {openUtilityPanel === 'settings' && (
        <SettingsPanel
          settings={settings}
          onOpinionTranslationChange={updateOpinionTranslation}
          onThemeChange={updateTheme}
          onNotificationsChange={updateNotifications}
          onFinancialDisplayChange={updateFinancialDisplay}
          onDisplayModeChange={updateDisplayMode}
          displayModeSwitching={surfaceSwitchState === 'switching'}
          displayModeSwitchError={surfaceSwitchState === 'error'}
          advancedContent={pipelineHealth !== undefined
            ? <PipelineDiagnostics health={pipelineHealth} now={() => diagnosticsNow} />
            : undefined}
        />
      )}

      {openUtilityPanel === 'support' && (
        <SupportPanel copyText={copyText} openLink={openLink} />
      )}
    </div>
  );
}
