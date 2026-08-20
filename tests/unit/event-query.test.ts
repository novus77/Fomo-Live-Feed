import { describe, expect, it, vi } from 'vitest';

import type { TradeEventV1 } from '../../src/domain/activity';
import type { TraderAnnotationV1 } from '../../src/domain/annotations';
import {
  DEFAULT_FILTERS,
  loadEventPages,
  matchesPostFilters,
  matchesSearch,
  normalizeSearchTerm,
  popupConnectionState,
  sortFeedEvents,
  toEventPageQuery,
  type Cursor,
} from '../../src/popup/event-query';
import type { EventPageQuery } from '../../src/storage/event-repository';

const NOW = 1_800_000_000_000;
const TOKEN_ADDRESS = '0x020bfc650a365f8bb26819deaabf3e21291018b4';

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
    usdAmount: 1250.5,
    occurredAt: NOW - 60_000,
    receivedAt: NOW,
    ...overrides,
  };
}

const EMPTY_ANNOTATIONS: ReadonlyMap<string, TraderAnnotationV1> = new Map();

describe('normalizeSearchTerm', () => {
  it('trims and lowercases the search input', () => {
    expect(normalizeSearchTerm('  ALPHA Whale  ')).toBe('alpha whale');
    expect(normalizeSearchTerm('')).toBe('');
    expect(normalizeSearchTerm('   ')).toBe('');
  });
});

describe('matchesSearch', () => {
  const event = makeEvent();

  it('matches the trader handle case-insensitively', () => {
    expect(matchesSearch(event, undefined, 'ALPHA')).toBe(true);
    expect(matchesSearch(event, undefined, 'alpha')).toBe(true);
  });

  it('matches the trader display name', () => {
    expect(matchesSearch(event, undefined, 'alpha whale')).toBe(true);
  });

  it('matches the token symbol', () => {
    expect(matchesSearch(event, undefined, 'fomo')).toBe(true);
  });

  it('matches the full contract address case-insensitively while preserving hex characters', () => {
    expect(matchesSearch(event, undefined, '0X020BFC650A365F8BB26819DEAABF3E21291018B4')).toBe(true);
    expect(matchesSearch(event, undefined, '020bfc65')).toBe(true);
  });

  it('matches an annotation label even when it belongs to a different trader', () => {
    const other = makeEvent({ id: 'fomo:event-9', traderId: 'trader-9', traderHandle: 'beta' });

    expect(matchesSearch(other, 'Whale Watch', 'whale watch')).toBe(true);
  });

  it('matches every event for an empty term', () => {
    expect(matchesSearch(event, undefined, '')).toBe(true);
  });

  it('returns false for a term that matches no field', () => {
    expect(matchesSearch(event, undefined, 'zzz')).toBe(false);
  });

  it('requires the label to be resolved for the event being searched', () => {
    // The caller resolves the label from the event's OWN traderId before
    // calling matchesSearch, so a label supplied here applies to this event.
    // A term that only exists in the label matches only when the label is
    // supplied.
    expect(matchesSearch(makeEvent(), 'Special Watch', 'special')).toBe(true);
    expect(matchesSearch(makeEvent(), undefined, 'special')).toBe(false);
  });
});

describe('matchesPostFilters', () => {
  it('applies the action filter', () => {
    expect(matchesPostFilters(makeEvent(), { ...DEFAULT_FILTERS, action: 'sell' }, EMPTY_ANNOTATIONS)).toBe(false);
    expect(matchesPostFilters(makeEvent(), { ...DEFAULT_FILTERS, action: 'buy' }, EMPTY_ANNOTATIONS)).toBe(true);
  });

  it('applies the search term against the annotation label map', () => {
    const withLabel: ReadonlyMap<string, TraderAnnotationV1> = new Map([
      ['trader-1', { traderId: 'trader-1', label: 'Whale Watch', updatedAt: 1 }],
    ]);

    expect(
      matchesPostFilters(makeEvent(), { ...DEFAULT_FILTERS, search: 'whale watch' }, withLabel),
    ).toBe(true);
    expect(
      matchesPostFilters(makeEvent({ traderId: 'trader-9' }), { ...DEFAULT_FILTERS, search: 'whale watch' }, withLabel),
    ).toBe(false);
  });

  it('matches everything with default filters', () => {
    expect(matchesPostFilters(makeEvent(), DEFAULT_FILTERS, EMPTY_ANNOTATIONS)).toBe(true);
  });
});

describe('toEventPageQuery', () => {
  it('maps popup filters to the storage query and never emits undefined keys', () => {
    const query = toEventPageQuery(
      {
        unreadOnly: true,
        action: 'buy',
        chain: 'bsc',
        traderId: 'trader-1',
        tokenAddress: TOKEN_ADDRESS,
        search: 'alpha',
      },
      50,
      null,
    );

    expect(query).toEqual({
      limit: 50,
      unreadOnly: true,
      chain: 'bsc',
      traderId: 'trader-1',
      tokenAddress: TOKEN_ADDRESS,
    });
    expect(Object.keys(query).sort()).toEqual(['chain', 'limit', 'tokenAddress', 'traderId', 'unreadOnly']);
  });

  it('carries the cursor into the next page', () => {
    const cursor: Cursor = { beforeOccurredAt: 123, beforeId: 'fomo:x' };

    expect(toEventPageQuery(DEFAULT_FILTERS, 50, cursor)).toEqual({
      limit: 50,
      beforeOccurredAt: 123,
      beforeId: 'fomo:x',
    });
  });

  it('omits optional filters that are not set', () => {
    expect(toEventPageQuery(DEFAULT_FILTERS, 50, null)).toEqual({ limit: 50 });
  });
});

describe('popupConnectionState', () => {
  it('is offline when no Fomo tab exists, whatever the socket state', () => {
    expect(
      popupConnectionState({ connected: true, authenticated: true, hasFomoTab: false }),
    ).toBe('offline');
    expect(
      popupConnectionState({ connected: false, authenticated: false, hasFomoTab: false }),
    ).toBe('offline');
  });

  it('is connected while any tab\'s authenticated socket is open (BLOCKING 2 steady state)', () => {
    expect(
      popupConnectionState({ connected: true, authenticated: true, hasFomoTab: true }),
    ).toBe('connected');
    expect(
      popupConnectionState({ connected: true, authenticated: true, hasFomoTab: false }),
    ).toBe('offline');
  });

  it('is login-required only when a Fomo tab exists and no authenticated socket was ever observed', () => {
    expect(
      popupConnectionState({ connected: false, authenticated: false, hasFomoTab: true }),
    ).toBe('login-required');
  });

  it('is reconnecting when the user is authenticated but every socket is closed', () => {
    expect(
      popupConnectionState({ connected: false, authenticated: true, hasFomoTab: true }),
    ).toBe('reconnecting');
  });
});

describe('sortFeedEvents', () => {
  it('keeps newest-first order when the pinned toggle is off', () => {
    const a = makeEvent({ id: 'a', traderId: 'trader-1', occurredAt: 300 });
    const b = makeEvent({ id: 'b', traderId: 'trader-2', occurredAt: 100 });

    expect(sortFeedEvents([b, a], false, EMPTY_ANNOTATIONS).map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('sorts pinned traders first only when the toggle is enabled', () => {
    const pinned: ReadonlyMap<string, TraderAnnotationV1> = new Map([
      ['trader-2', { traderId: 'trader-2', pinned: true, updatedAt: 1 }],
    ]);
    const a = makeEvent({ id: 'a', traderId: 'trader-1', occurredAt: 300 });
    const b = makeEvent({ id: 'b', traderId: 'trader-2', occurredAt: 100 });

    expect(sortFeedEvents([a, b], false, pinned).map((e) => e.id)).toEqual(['a', 'b']);
    expect(sortFeedEvents([a, b], true, pinned).map((e) => e.id)).toEqual(['b', 'a']);
  });

  it('breaks same-timestamp ties by id descending', () => {
    const a = makeEvent({ id: 'a', occurredAt: 100 });
    const b = makeEvent({ id: 'b', occurredAt: 100 });

    expect(sortFeedEvents([a, b], false, EMPTY_ANNOTATIONS).map((e) => e.id)).toEqual(['b', 'a']);
  });
});

describe('loadEventPages pagination termination', () => {
  const noMatch = (index: number): TradeEventV1 =>
    makeEvent({
      id: 'nomatch-' + index,
      traderHandle: 'zzz',
      traderName: 'Zed Zed',
      tokenSymbol: 'ZZZ',
    });
  const match = (index: number): TradeEventV1 =>
    makeEvent({ id: 'match-' + index, traderHandle: 'alpha', tokenSymbol: 'FOMO' });

  it('keeps requesting pages when a page is fully filtered out until the limit is met or data is exhausted', async () => {
    const calls: TradeEventV1[][] = [[noMatch(1), noMatch(2)], [match(1)]];
    const queries: EventPageQuery[] = [];
    const fetchPage = vi.fn(async (query: EventPageQuery): Promise<TradeEventV1[]> => {
      queries.push(query);

      return calls.shift() ?? [];
    });

    const result = await loadEventPages(
      fetchPage,
      { ...DEFAULT_FILTERS, search: 'alpha' },
      EMPTY_ANNOTATIONS,
      2,
    );

    // The raw accumulated rows include the fully-filtered first page; the
    // display layer filters them down to the single match.
    expect(result.events.map((e) => e.id)).toEqual(['nomatch-1', 'nomatch-2', 'match-1']);
    expect(result.hasMore).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(2);

    const secondQuery = queries[1];

    expect(secondQuery).toMatchObject({
      beforeOccurredAt: noMatch(2).occurredAt,
      beforeId: noMatch(2).id,
    });
  });

  it('stops immediately when the first page already meets the limit', async () => {
    const fetchPage = vi.fn(async (): Promise<TradeEventV1[]> => [match(1), match(2)]);

    const result = await loadEventPages(fetchPage, DEFAULT_FILTERS, EMPTY_ANNOTATIONS, 2);

    expect(result.events.map((e) => e.id)).toEqual(['match-1', 'match-2']);
    expect(result.hasMore).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('terminates when the data is exhausted even when every page is fully filtered out', async () => {
    const calls: TradeEventV1[][] = [
      [noMatch(1), noMatch(2)],
      [noMatch(3), noMatch(4)],
      [],
    ];
    const fetchPage = vi.fn(async (): Promise<TradeEventV1[]> => calls.shift() ?? []);

    const result = await loadEventPages(
      fetchPage,
      { ...DEFAULT_FILTERS, search: 'alpha' },
      EMPTY_ANNOTATIONS,
      2,
    );

    // The loop returned the raw rows (the display layer filters them), so
    // every accumulated row is present but NONE of them match the search.
    expect(result.events).toHaveLength(4);
    expect(
      result.events.filter((event) =>
        matchesPostFilters(event, { ...DEFAULT_FILTERS, search: 'alpha' }, EMPTY_ANNOTATIONS),
      ),
    ).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('reports hasMore when matches span multiple pages and the limit is reached', async () => {
    const calls: TradeEventV1[][] = [[noMatch(1), noMatch(2)], [match(1), match(2)]];
    const fetchPage = vi.fn(async (): Promise<TradeEventV1[]> => calls.shift() ?? []);

    const result = await loadEventPages(
      fetchPage,
      { ...DEFAULT_FILTERS, search: 'alpha' },
      EMPTY_ANNOTATIONS,
      2,
    );

    expect(result.hasMore).toBe(true);
    expect(result.scanExceeded).toBe(false);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('bounded page-scan cap: stops a sparse search after maxScanPages (SHOULD-FIX 4)', async () => {
    const fetchPage = vi.fn(
      async (): Promise<TradeEventV1[]> => [noMatch(1), noMatch(2)],
    );

    const result = await loadEventPages(
      fetchPage,
      { ...DEFAULT_FILTERS, search: 'alpha' },
      EMPTY_ANNOTATIONS,
      2,
      null,
      3,
    );

    // Three full pages scanned, none matched the display limit: the loop
    // stops with a clear scanExceeded signal instead of scanning all history.
    expect(result.events).toHaveLength(6);
    expect(result.hasMore).toBe(true);
    expect(result.scanExceeded).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('never sets scanExceeded when the display limit is met or data is exhausted', async () => {
    // Display limit met on the first page: no scan cap signal, even with a
    // cap of 1.
    const matches = vi.fn(async (): Promise<TradeEventV1[]> => [match(1), match(2)]);

    const result = await loadEventPages(
      matches,
      { ...DEFAULT_FILTERS, search: 'alpha' },
      EMPTY_ANNOTATIONS,
      2,
      null,
      1,
    );

    expect(result.scanExceeded).toBe(false);
    expect(result.hasMore).toBe(true);

    // Data exhausted before the cap (a PARTIAL final page proves the store
    // is out of rows, so no scan cap signal).
    const exhausted = vi.fn(async (): Promise<TradeEventV1[]> => [noMatch(1)]);
    const short = await loadEventPages(
      exhausted,
      { ...DEFAULT_FILTERS, search: 'alpha' },
      EMPTY_ANNOTATIONS,
      2,
      null,
      1,
    );

    expect(short.scanExceeded).toBe(false);
    expect(short.hasMore).toBe(false);
  });

  it('rejects an invalid maxScanPages', async () => {
    const fetchPage = vi.fn(async (): Promise<TradeEventV1[]> => []);

    await expect(
      loadEventPages(fetchPage, DEFAULT_FILTERS, EMPTY_ANNOTATIONS, 2, null, 0),
    ).rejects.toThrowError(TypeError);
  });
});
