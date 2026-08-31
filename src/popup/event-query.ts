import type {
  ActivityAction,
  ChainKey,
  TradeEventV1,
} from '../domain/activity';
import type { TraderAnnotationV1 } from '../domain/annotations';
import { MAX_QUERY_LIMIT } from '../messaging/protocol';
import {
  FILTERABLE_CHAINS,
  type FilterableChain,
} from '../sidepanel/chain-visibility';
import type { EventPageQuery } from '../storage/event-repository';

/**
 * Popup-side query model (plan Task 9 Steps 1-2, spec section 7.3).
 *
 * The IndexedDB layer can only execute the predicates its indexes express
 * (traderId, chain, tokenAddress, unreadOnly, cursor, limit - see
 * EventPageQuery and EventRepository.selectIndexedCollection). Two filters
 * deliberately stay POPUP-SIDE:
 *
 * - action: no DB index exists, so it is applied to the already-fetched
 *   page rows in memory.
 * - search: normalized text matching over trader handle/display name, token
 *   symbol, full contract address, AND annotation labels. Labels live in
 *   chrome.storage.local and are unreachable from any Dexie index, so label
 *   matching is resolved here against the annotation map.
 *
 * Pagination must still terminate when a whole page is filtered out:
 * loadEventPages keeps requesting pages (advancing the cursor past every
 * returned row, matched or not) until the display limit is met, the data is
 * exhausted, or the bounded page-scan cap is hit (SHOULD-FIX 4 - a sparse
 * post-filter must not scan all history in 50-row round trips). The search
 * path is therefore NOT an unbounded "candidate set" scan: after the cap it
 * reports scanExceeded and the UI asks the user to narrow the search. Both
 * behaviors are proven in tests/unit/event-query.test.ts.
 */

/** Initial feed page size and the display limit used by the load loop. */
export const DEFAULT_PAGE_SIZE = 50;

/** Cursor position: strictly before (occurredAt, id), matching the repository. */
export interface Cursor {
  beforeOccurredAt: number;
  beforeId: string;
}

export interface PopupEventFilters {
  unreadOnly: boolean;
  action: ActivityAction | undefined;
  chain: ChainKey | undefined;
  traderId: string | undefined;
  tokenAddress: string | undefined;
  search: string;
  visibleActions: VisibleActionFilters;
  visibleChains: readonly FilterableChain[];
  minimumMarketCap: number | undefined;
  maximumMarketCap: number | undefined;
}

/** Action types controlled by the compact Side Panel visibility filters. */
export type FilterableAction = Extract<ActivityAction, 'buy' | 'sell' | 'thesis'>;

export interface VisibleActionFilters {
  buy: boolean;
  sell: boolean;
  thesis: boolean;
}

export const DEFAULT_VISIBLE_ACTIONS: VisibleActionFilters = {
  buy: true,
  sell: true,
  thesis: true,
};

export const DEFAULT_FILTERS: PopupEventFilters = {
  unreadOnly: false,
  action: undefined,
  chain: undefined,
  traderId: undefined,
  tokenAddress: undefined,
  search: '',
  visibleActions: DEFAULT_VISIBLE_ACTIONS,
  visibleChains: [...FILTERABLE_CHAINS],
  minimumMarketCap: undefined,
  maximumMarketCap: undefined,
};

/** Number shown on the filter trigger; search and feed ordering are excluded. */
export function activeFilterCount(filters: PopupEventFilters): number {
  return Number(filters.unreadOnly)
    + Number(filters.action !== undefined)
    + Number(filters.chain !== undefined)
    + Number(filters.traderId !== undefined)
    + Number(filters.tokenAddress !== undefined);
}

/** Number shown on the Side Panel funnel: action visibility and MC range. */
export function activeSidePanelFilterGroupCount(filters: PopupEventFilters): number {
  const actionsChanged = (Object.keys(DEFAULT_VISIBLE_ACTIONS) as FilterableAction[])
    .some((action) => filters.visibleActions[action] !== DEFAULT_VISIBLE_ACTIONS[action]);
  const hasMarketCapRange = filters.minimumMarketCap !== undefined
    || filters.maximumMarketCap !== undefined;
  const chainsChanged = filters.visibleChains.length !== FILTERABLE_CHAINS.length
    || FILTERABLE_CHAINS.some((chain) => !filters.visibleChains.includes(chain));

  return Number(actionsChanged) + Number(chainsChanged) + Number(hasMarketCapRange);
}

export interface PopupTraderOption {
  traderId: string;
  handle: string;
  name: string | undefined;
}

export interface PopupTokenOption {
  address: string;
  symbol: string;
}

/**
 * Top-level popup states (plan Task 9 Step 3, BLOCKING 2 rewrite).
 *
 * 'loading' is the initial state before connection.query resolves (the old
 * code flashed 'offline' during that window - NIT). The connected feed
 * states are rendered by the feed; the failure states render a banner plus
 * the stored history READ-ONLY (rows are shown but never marked read while
 * not connected - BLOCKING 1).
 */
export type PopupConnectionState =
  | 'loading'
  | 'login-required'
  | 'offline'
  | 'reconnecting'
  | 'connected';

/**
 * The worker's connection.query verdict (BLOCKING 2).
 *
 * connected is the EXPLICIT socket open state (at least one tracked tab's
 * authenticated socket is open) - an idle-but-open socket stays connected
 * however quiet. authenticated is the honest auth signal derived from the
 * interceptor observing the authenticated socket OPEN (an unauthenticated
 * page cannot open it); it never comes from cookies. hasFomoTab is
 * tabs.query.
 */
export interface ConnectionVerdict {
  connected: boolean;
  authenticated: boolean;
  hasFomoTab: boolean;
}

/**
 * Maps the worker's connection.query verdict to the popup state.
 *
 * - no Fomo tab at all -> offline;
 * - any tab's authenticated socket open -> connected (however quiet);
 * - a Fomo tab exists, was authenticated, but every socket is closed ->
 *   reconnecting (spec section 8 "WebSocket disconnect"): the user IS logged
 *   in, the socket is just reconnecting - never login-required;
 * - a Fomo tab exists and no authenticated socket was ever observed on it ->
 *   login-required (an unauthenticated page cannot open the authenticated
 *   socket, so this is now an honest auth verdict).
 */
export function popupConnectionState(verdict: ConnectionVerdict): PopupConnectionState {
  if (!verdict.hasFomoTab) {
    return 'offline';
  }

  if (verdict.connected) {
    return 'connected';
  }

  if (verdict.authenticated) {
    return 'reconnecting';
  }

  return 'login-required';
}

/** Trims and lowercases the search input for case-insensitive matching. */
export function normalizeSearchTerm(input: string): string {
  return input.trim().toLowerCase();
}

/**
 * Case-insensitive text match across trader handle, display name, token
 * symbol, the FULL contract address, and the annotation label. The address
 * comparison preserves hex characters (lowercasing keeps a-f0-9 intact) and
 * compares case-insensitively, so 0X.. and 0x.. forms both match.
 */
export function matchesSearch(
  event: TradeEventV1,
  annotationLabel: string | undefined,
  term: string,
): boolean {
  const normalized = normalizeSearchTerm(term);

  if (normalized.length === 0) {
    return true;
  }

  const haystacks = [
    event.traderHandle,
    event.traderName,
    event.tokenSymbol,
    event.tokenAddress,
    annotationLabel,
  ];

  return haystacks.some(
    (value) => value !== undefined && value.toLowerCase().includes(normalized),
  );
}

/**
 * Applies the popup-side post-filters (legacy action, Side Panel action
 * visibility / market cap, and normalized search including annotation labels)
 * to one already-fetched event row.
 */
export function matchesPostFilters(
  event: TradeEventV1,
  filters: PopupEventFilters,
  annotations: ReadonlyMap<string, TraderAnnotationV1>,
): boolean {
  if (
    event.chain === 'unknown'
    || !filters.visibleChains.includes(event.chain)
  ) {
    return false;
  }

  if (filters.action !== undefined && event.action !== filters.action) {
    return false;
  }

  if (
    (event.action === 'buy' || event.action === 'sell' || event.action === 'thesis')
    && !filters.visibleActions[event.action]
  ) {
    return false;
  }

  if (filters.minimumMarketCap !== undefined || filters.maximumMarketCap !== undefined) {
    if (typeof event.marketCap !== 'number' || !Number.isFinite(event.marketCap)) {
      return false;
    }

    if (filters.minimumMarketCap !== undefined && event.marketCap < filters.minimumMarketCap) {
      return false;
    }

    if (filters.maximumMarketCap !== undefined && event.marketCap > filters.maximumMarketCap) {
      return false;
    }
  }

  return matchesSearch(event, annotations.get(event.traderId)?.label, filters.search);
}

/**
 * Maps popup filters to the storage query. search, action visibility, and
 * market cap are never emitted: they have no DB index and are applied
 * popup-side. Conditional
 * spreads keep every key absent (never undefined) so the transport stays
 * exactOptionalPropertyTypes-clean.
 */
export function toEventPageQuery(
  filters: PopupEventFilters,
  limit: number,
  cursor: Cursor | null,
): EventPageQuery {
  return {
    limit,
    ...(cursor !== null
      ? { beforeOccurredAt: cursor.beforeOccurredAt, beforeId: cursor.beforeId }
      : {}),
    ...(filters.unreadOnly ? { unreadOnly: true } : {}),
    ...(filters.chain !== undefined ? { chain: filters.chain } : {}),
    ...(filters.traderId !== undefined ? { traderId: filters.traderId } : {}),
    ...(filters.tokenAddress !== undefined
      ? { tokenAddress: filters.tokenAddress }
      : {}),
  };
}

/**
 * Sorts the loaded rows for display: pinned traders first ONLY when the
 * explicit pinned-first toggle is on, then newest-first with the same
 * (occurredAt desc, id desc) tie-break the repository's reverse index uses.
 */
export function sortFeedEvents(
  events: readonly TradeEventV1[],
  pinnedFirst: boolean,
  annotations: ReadonlyMap<string, TraderAnnotationV1>,
): TradeEventV1[] {
  const pinnedTraderIds = new Set<string>();

  if (pinnedFirst) {
    for (const annotation of annotations.values()) {
      if (annotation.pinned === true) {
        pinnedTraderIds.add(annotation.traderId);
      }
    }
  }

  return [...events].sort((a, b) => {
    if (pinnedFirst) {
      const aPinned = pinnedTraderIds.has(a.traderId) ? 1 : 0;
      const bPinned = pinnedTraderIds.has(b.traderId) ? 1 : 0;

      if (aPinned !== bPinned) {
        return bPinned - aPinned;
      }
    }

    if (a.occurredAt !== b.occurredAt) {
      return b.occurredAt - a.occurredAt;
    }

    return b.id.localeCompare(a.id);
  });
}

export interface LoadedEventPages {
  /** All raw rows fetched so far (DB-level filters applied, post-filters NOT). */
  events: TradeEventV1[];
  /** Cursor to continue from, or null when nothing was fetched. */
  cursor: Cursor | null;
  /** True when more rows MAY exist beyond the fetched cursor. */
  hasMore: boolean;
  /**
   * True when the bounded page-scan cap was hit before the display limit was
   * met (SHOULD-FIX 4): the post-filters match too sparsely, so the UI should
   * surface a "narrow your search" affordance instead of silently scanning
   * the whole history in 50-row round trips.
   */
  scanExceeded: boolean;
}

/**
 * Upper bound on the number of pages loadEventPages will scan before giving
 * up on a sparse post-filter (SHOULD-FIX 4). At 50 rows/page this caps a
 * worst-case search at about 10 sequential round trips instead of about 400
 * at the 20k-event ceiling.
 */
export const DEFAULT_MAX_SCAN_PAGES = 10;

/**
 * Fetches bounded pages and accumulates RAW rows until the display limit is
 * met or the data is exhausted. The termination rule is the critical part:
 * a page whose rows are ALL filtered out by the post-filters (for example a
 * search that matches nothing on this page) does NOT stop the loop - the
 * cursor advances past every returned row and the next page is requested.
 * The loop provably terminates because each iteration consumes a bounded
 * page and the store is finite.
 *
 * SHOULD-FIX 4: the loop is ALSO capped by maxScanPages. A post-filter that
 * matches little must not scan the entire history in 50-row round trips
 * (about 400 sequential sendMessage calls at the 20k-event ceiling); after
 * the cap, the result reports scanExceeded so the UI can tell the user to
 * narrow the search instead of pretending the loop bounded the candidate set.
 */
export async function loadEventPages(
  fetchPage: (query: EventPageQuery) => Promise<TradeEventV1[]>,
  filters: PopupEventFilters,
  annotations: ReadonlyMap<string, TraderAnnotationV1>,
  pageSize: number,
  fromCursor: Cursor | null = null,
  maxScanPages: number = DEFAULT_MAX_SCAN_PAGES,
): Promise<LoadedEventPages> {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_QUERY_LIMIT) {
    throw new TypeError(
      'pageSize must be an integer between 1 and ' + MAX_QUERY_LIMIT,
    );
  }

  if (!Number.isInteger(maxScanPages) || maxScanPages < 1) {
    throw new TypeError('maxScanPages must be a positive integer');
  }

  if (filters.visibleChains.length === 0) {
    return {
      events: [],
      cursor: fromCursor,
      hasMore: false,
      scanExceeded: false,
    };
  }

  const accumulated: TradeEventV1[] = [];
  let cursor: Cursor | null = fromCursor;
  let pagesFetched = 0;

  for (;;) {
    const page = await fetchPage(toEventPageQuery(filters, pageSize, cursor));

    pagesFetched += 1;
    accumulated.push(...page);

    if (page.length === 0) {
      return { events: accumulated, cursor, hasMore: false, scanExceeded: false };
    }

    const last = page[page.length - 1];

    if (last === undefined) {
      return { events: accumulated, cursor, hasMore: false, scanExceeded: false };
    }

    cursor = { beforeOccurredAt: last.occurredAt, beforeId: last.id };

    const matched = accumulated.filter((event) =>
      matchesPostFilters(event, filters, annotations),
    ).length;

    if (matched >= pageSize) {
      return { events: accumulated, cursor, hasMore: true, scanExceeded: false };
    }

    if (page.length < pageSize) {
      return { events: accumulated, cursor, hasMore: false, scanExceeded: false };
    }

    if (pagesFetched >= maxScanPages) {
      return { events: accumulated, cursor, hasMore: true, scanExceeded: true };
    }
  }
}

/**
 * Distinct traders/tokens seen in the loaded rows, for the filter dropdowns.
 * Options only include traders/tokens the user has already loaded, which is
 * the MVP contract: the dropdown is a navigation aid over visible history.
 */
export function distinctTraders(
  events: readonly TradeEventV1[],
): PopupTraderOption[] {
  const map = new Map<string, PopupTraderOption>();

  for (const event of events) {
    if (!map.has(event.traderId)) {
      map.set(event.traderId, {
        traderId: event.traderId,
        handle: event.traderHandle,
        name: event.traderName,
      });
    }
  }

  return [...map.values()].sort((a, b) => a.handle.localeCompare(b.handle));
}

export function distinctTokens(events: readonly TradeEventV1[]): PopupTokenOption[] {
  const map = new Map<string, PopupTokenOption>();

  for (const event of events) {
    if (!map.has(event.tokenAddress)) {
      map.set(event.tokenAddress, {
        address: event.tokenAddress,
        symbol: event.tokenSymbol,
      });
    }
  }

  return [...map.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
}
