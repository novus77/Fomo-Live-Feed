import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TradeEventV1 } from '../domain/activity';
import type { TraderAnnotationV1 } from '../domain/annotations';
import type { EventPageQuery } from '../storage/event-repository';
import { parseExtensionMessage } from '../messaging/protocol';
import {
  DEFAULT_MAX_SCAN_PAGES,
  DEFAULT_PAGE_SIZE,
  distinctTraders,
  distinctTokens,
  loadEventPages,
  matchesPostFilters,
  sortFeedEvents,
  type Cursor,
  type PopupEventFilters,
  type PopupTokenOption,
  type PopupTraderOption,
} from './event-query';

/**
 * Paginated, searchable feed hook (plan Task 9 Steps 2-3).
 *
 * - DB-executed filters (unread/chain/trader/token) are sent through
 *   fetchPage; the search term and action filter are applied popup-side.
 * - The load loop (loadEventPages) keeps requesting pages when a page is
 *   fully filtered out, so search results deep in history are found and
 *   pagination terminates (proven in event-query.test.ts). The loop is
 *   bounded by a page-scan cap (SHOULD-FIX 4) and surfaces scanExceeded so
 *   the UI can ask the user to narrow a sparse search.
 * - Read state: after the visible rows render, the unread ones are marked
 *   read with the injected clock (plan Step 3) and the local rows update so
 *   the badge clearing and the read styling happen without a refetch. Rows
 *   never fetched are never marked. BLOCKING 1: when readEnabled is false
 *   (the popup is offline / login-required / reconnecting), NOTHING is ever
 *   marked read - rows shown in those states are read-only. And a failed
 *   worker markRead never updates the local readAt (NIT): the UI must not
 *   claim a row is read until the worker confirmed it.
 * - Pinned-first is a pure display re-sort gated on the explicit toggle.
 * - Annotation changes re-filter and re-sort the already-loaded rows in
 *   memory; they never trigger a DB reload (labels participate in search,
 *   so a label edit while searching re-evaluates the loaded pages).
 * - A failed full load surfaces an explicit retryable error and clears its
 *   pagination snapshot, so a cursor from the previous filter can never be
 *   reused with the new filter. Live-refresh failures preserve the last
 *   coherent ready snapshot instead.
 */

export interface EventFeedDeps {
  fetchPage(query: EventPageQuery): Promise<TradeEventV1[]>;
  /** Resolves true only when the worker confirmed the rows were marked. */
  markRead(ids: readonly string[], at: number): Promise<boolean>;
  annotations: ReadonlyMap<string, TraderAnnotationV1>;
  now: () => number;
  pageSize?: number;
  /** False in the non-connected popup states: rows render read-only. */
  readEnabled?: boolean;
  /** Bounded page-scan cap for sparse post-filters (SHOULD-FIX 4). */
  maxScanPages?: number;
  eventsChanged?: {
    addListener(listener: (message: unknown) => void): void;
    removeListener(listener: (message: unknown) => void): void;
  };
}

const EVENTS_CHANGED_DEBOUNCE_MS = 50;
const EVENTS_CHANGED_MAX_WAIT_MS = 250;

export interface EventFeedState {
  /** Rows shown to the user: post-filtered (search/action) and sorted. */
  events: TradeEventV1[];
  status: 'loading' | 'ready' | 'error';
  hasMore: boolean;
  loadingMore: boolean;
  /** True when the scan cap was hit before the display limit (SHOULD-FIX 4). */
  scanExceeded: boolean;
  /** Distinct traders/tokens from the VISIBLE rows, for the filter dropdowns. */
  traders: PopupTraderOption[];
  tokens: PopupTokenOption[];
  loadMore(): void;
  retry(): void;
}

export function useEventFeed(
  filters: PopupEventFilters,
  pinnedFirst: boolean,
  deps: EventFeedDeps,
): EventFeedState {
  const { fetchPage, markRead, annotations, now } = deps;
  const pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
  const maxScanPages = deps.maxScanPages ?? DEFAULT_MAX_SCAN_PAGES;
  const readEnabled = deps.readEnabled ?? true;

  const [rawEvents, setRawEvents] = useState<TradeEventV1[]>([]);
  const [displayEvents, setDisplayEvents] = useState<TradeEventV1[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [pagination, setPagination] = useState({ hasMore: false, scanExceeded: false });
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const paginationRef = useRef<{
    cursor: Cursor | null;
    hasMore: boolean;
    scanExceeded: boolean;
  }>({ cursor: null, hasMore: false, scanExceeded: false });
  const requestedReadRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(false);
  const filtersRef = useRef<PopupEventFilters>(filters);
  const generationRef = useRef(0);
  const liveRefreshingRef = useRef(false);
  const fullReloadGenerationRef = useRef<number | null>(null);
  const pendingLiveRefreshRef = useRef(false);
  const requestLiveRefreshRef = useRef<() => void>(() => {});

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const source = deps.eventsChanged;
    if (source === undefined) {
      return;
    }

    let disposed = false;
    let trailingTimer: ReturnType<typeof setTimeout> | undefined;
    let maxWaitTimer: ReturnType<typeof setTimeout> | undefined;
    const flush = (): void => {
      clearTimeout(trailingTimer);
      clearTimeout(maxWaitTimer);
      trailingTimer = undefined;
      maxWaitTimer = undefined;
      if (!disposed) requestLiveRefreshRef.current();
    };
    const onMessage = (message: unknown): void => {
      const parsed = parseExtensionMessage(message);
      if (!parsed.ok || parsed.message.type !== 'events.changed') {
        return;
      }
      clearTimeout(trailingTimer);
      trailingTimer = setTimeout(flush, EVENTS_CHANGED_DEBOUNCE_MS);
      maxWaitTimer ??= setTimeout(flush, EVENTS_CHANGED_MAX_WAIT_MS);
    };

    source.addListener(onMessage);
    return () => {
      disposed = true;
      clearTimeout(trailingTimer);
      clearTimeout(maxWaitTimer);
      source.removeListener(onMessage);
    };
  }, [deps.eventsChanged]);

  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  const load = useCallback(
    async (fromCursor: Cursor | null): Promise<{
      events: TradeEventV1[];
      cursor: Cursor | null;
      hasMore: boolean;
      scanExceeded: boolean;
    }> =>
      loadEventPages(
        fetchPage,
        filtersRef.current,
        annotations,
        pageSize,
        fromCursor,
        maxScanPages,
      ),
    [fetchPage, annotations, pageSize, maxScanPages],
  );

  const commitPage = useCallback((result: {
    cursor: Cursor | null;
    hasMore: boolean;
    scanExceeded: boolean;
  }): void => {
    const next = {
      cursor: result.cursor,
      hasMore: result.hasMore,
      scanExceeded: result.scanExceeded,
    };
    paginationRef.current = next;
    setPagination({ hasMore: next.hasMore, scanExceeded: next.scanExceeded });
  }, []);

  // Live refreshes preserve visible rows and pagination until a replacement
  // page succeeds. Only one query runs at a time; changes received while it
  // is in flight become one dirty follow-up, so slow queries cannot be
  // repeatedly invalidated by the max-wait timer.
  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let dirty = false;

    const refresh = async (): Promise<void> => {
      if (inFlight) {
        dirty = true;
        return;
      }

      inFlight = true;
      liveRefreshingRef.current = true;
      const generation = ++generationRef.current;
      try {
        const result = await load(null);
        if (!disposed && generation === generationRef.current) {
          commitPage(result);
          setRawEvents(result.events);
          setStatus('ready');
        }
      } catch {
        // Keep the last coherent rows and pagination snapshot.
      } finally {
        inFlight = false;
        if (disposed || generation !== generationRef.current) {
          dirty = false;
          liveRefreshingRef.current = false;
          setLoadingMore(false);
          return;
        }
        if (dirty) {
          dirty = false;
          void refresh();
          return;
        }
        liveRefreshingRef.current = false;
        setLoadingMore(false);
      }
    };

    requestLiveRefreshRef.current = () => {
      if (fullReloadGenerationRef.current !== null) {
        pendingLiveRefreshRef.current = true;
        return;
      }
      if (inFlight) dirty = true;
      else void refresh();
    };
    return () => {
      disposed = true;
      requestLiveRefreshRef.current = () => {};
    };
  }, [load, commitPage]);

  // Full reload whenever a filter changes (search included) or retry() is
  // called. Annotation changes intentionally do NOT reload: the display
  // effect below re-filters and re-sorts the loaded rows in memory.
  useEffect(() => {
    let cancelled = false;
    const generation = ++generationRef.current;
    fullReloadGenerationRef.current = generation;
    let succeeded = false;

    setStatus('loading');
    setLoadingMore(false);
    requestedReadRef.current = new Set();

    void load(null)
      .then((result) => {
        if (cancelled || generation !== generationRef.current) {
          return;
        }

        commitPage(result);
        setRawEvents(result.events);
        setStatus('ready');
        succeeded = true;
      })
      .catch(() => {
        // A full reload belongs to the CURRENT filters. On failure, clear the
        // previous filter's rows and pagination together so retry is the only
        // path that can establish a new coherent snapshot.
        if (!cancelled && generation === generationRef.current) {
          commitPage({ cursor: null, hasMore: false, scanExceeded: false });
          setRawEvents([]);
          setStatus('error');
        }
      })
      .finally(() => {
        if (
          cancelled ||
          fullReloadGenerationRef.current !== generation
        ) {
          return;
        }

        fullReloadGenerationRef.current = null;
        const followUp = pendingLiveRefreshRef.current;
        pendingLiveRefreshRef.current = false;
        if (succeeded && followUp) {
          requestLiveRefreshRef.current();
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    fetchPage,
    pageSize,
    maxScanPages,
    commitPage,
    reloadToken,
    filters.unreadOnly,
    filters.action,
    filters.chain,
    filters.traderId,
    filters.tokenAddress,
    filters.search,
    filters.visibleActions.buy,
    filters.visibleActions.sell,
    filters.visibleActions.thesis,
    filters.minimumMarketCap,
    filters.maximumMarketCap,
  ]);

  // Display rows: post-filter (search/action, labels included) + sort. This
  // runs whenever the raw rows, filters, annotations, or the pin toggle
  // change, without another DB fetch.
  useEffect(() => {
    const filtered = rawEvents.filter((event) =>
      matchesPostFilters(event, filters, annotations),
    );

    setDisplayEvents(sortFeedEvents(filtered, pinnedFirst, annotations));
  }, [rawEvents, filters, annotations, pinnedFirst]);

  // Read state: mark the unread rows the user actually sees, after render -
  // ONLY while readEnabled (BLOCKING 1). The requestedRead set prevents
  // duplicate sends (StrictMode double effects included), the local readAt
  // update happens ONLY when the worker confirmed the write (NIT), and a
  // failed write removes the ids from the set so a later pass can retry.
  useEffect(() => {
    if (!readEnabled || status !== 'ready') {
      return;
    }

    const unreadVisible = displayEvents.filter(
      (event) =>
        event.readAt === undefined && !requestedReadRef.current.has(event.id),
    );

    if (unreadVisible.length === 0) {
      return;
    }

    const ids = unreadVisible.map((event) => event.id);

    for (const id of ids) {
      requestedReadRef.current.add(id);
    }

    const at = now();

    void markRead(ids, at).then((succeeded) => {
      if (!mountedRef.current) {
        return;
      }

      if (succeeded) {
        const idSet = new Set(ids);

        setRawEvents((prev) =>
          prev.map((event) =>
            idSet.has(event.id) && event.readAt === undefined
              ? { ...event, readAt: at }
              : event,
          ),
        );
      } else {
        for (const id of ids) {
          requestedReadRef.current.delete(id);
        }
      }
    });
  }, [displayEvents, status, markRead, now, readEnabled]);

  const loadMore = useCallback(() => {
    if (
      status !== 'ready' ||
      loadingMore ||
      liveRefreshingRef.current ||
      !pagination.hasMore
    ) {
      return;
    }

    const snapshotFilters = filtersRef.current;
    const generation = generationRef.current;
    const cursor = paginationRef.current.cursor;

    if (cursor === null) {
      return;
    }

    setLoadingMore(true);

    void load(cursor)
      .then((result) => {
        if (
          filtersRef.current !== snapshotFilters ||
          generation !== generationRef.current
        ) {
          // Filters changed mid-flight; the reload effect owns the new state.
          return;
        }

        commitPage(result);
        setRawEvents((prev) => {
          const seen = new Set(prev.map((event) => event.id));

          return [
            ...prev,
            ...result.events.filter((event) => !seen.has(event.id)),
          ];
        });
      })
      .catch(() => {})
      .finally(() => {
        if (generation === generationRef.current) {
          setLoadingMore(false);
        }
      });
  }, [load, status, loadingMore, pagination.hasMore, commitPage]);

  const retry = useCallback(() => {
    setReloadToken((token) => token + 1);
  }, []);

  // NIT: dropdown options come from the VISIBLE (post-filtered) rows, so a
  // search that hides a trader/token no longer offers it as a filter target.
  const traders = useMemo(() => distinctTraders(displayEvents), [displayEvents]);
  const tokens = useMemo(() => distinctTokens(displayEvents), [displayEvents]);

  return {
    events: displayEvents,
    status,
    hasMore: pagination.hasMore,
    loadingMore,
    scanExceeded: pagination.scanExceeded,
    traders,
    tokens,
    loadMore,
    retry,
  };
}
