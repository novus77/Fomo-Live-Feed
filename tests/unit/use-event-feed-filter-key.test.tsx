import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { TradeEventV1 } from '../../src/domain/activity';
import { DEFAULT_FILTERS, type PopupEventFilters } from '../../src/popup/event-query';
import { useEventFeed } from '../../src/popup/use-event-feed';
import type { EventPageQuery } from '../../src/storage/event-repository';

const NOW = 1_800_000_000_000;

function makeEvent(index: number, overrides: Partial<TradeEventV1> = {}): TradeEventV1 {
  return {
    schemaVersion: 1,
    id: `event-${index}`,
    source: 'fomo',
    traderId: `trader-${index}`,
    traderHandle: `trader-${index}`,
    chain: 'bsc',
    tokenAddress: `0x${String(index).padStart(40, '0')}`,
    tokenSymbol: `TOKEN${index}`,
    action: 'buy',
    usdAmount: 1,
    occurredAt: NOW - index,
    receivedAt: NOW,
    ...overrides,
  };
}

function createPagedFetch(events: readonly TradeEventV1[]) {
  return vi.fn(async (query: EventPageQuery): Promise<TradeEventV1[]> => {
    if (query.beforeOccurredAt === undefined || query.beforeId === undefined) {
      return events.slice(0, query.limit);
    }

    const cursorIndex = events.findIndex(
      (event) => event.occurredAt === query.beforeOccurredAt && event.id === query.beforeId,
    );
    return cursorIndex === -1 ? [] : events.slice(cursorIndex + 1, cursorIndex + 1 + query.limit);
  });
}

function renderFeed(
  initialFilters: PopupEventFilters,
  events: readonly TradeEventV1[],
  options: { canMarkRead?: (event: TradeEventV1) => boolean } = {},
) {
  const fetchPage = createPagedFetch(events);
  const markRead = vi.fn(async (): Promise<boolean> => true);
  const deps = {
    fetchPage,
    markRead,
    annotations: new Map(),
    now: () => NOW,
    ...options,
  };

  return {
    fetchPage,
    markRead,
    ...renderHook(
      ({ filters }: { filters: PopupEventFilters }) => useEventFeed(filters, false, deps),
      { initialProps: { filters: initialFilters } },
    ),
  };
}

describe('useEventFeed query signature', () => {
  it('does not let a disposed head refresh release a newer head refresh lock', async () => {
    const oldEvents = [makeEvent(0), makeEvent(1)];
    const filteredEvents = [makeEvent(2), makeEvent(3)];
    const listeners = new Set<(message: unknown) => void>();
    let releaseOldHead!: (events: TradeEventV1[]) => void;
    let releaseNewHead!: (events: TradeEventV1[]) => void;
    let oldHeadQueries = 0;
    let newHeadQueries = 0;
    let historyQueries = 0;
    const fetchPage = vi.fn((query: EventPageQuery): Promise<TradeEventV1[]> => {
      if (query.beforeId !== undefined) {
        historyQueries += 1;
        return Promise.resolve([]);
      }
      if (query.chain === 'solana') {
        newHeadQueries += 1;
        return newHeadQueries === 1
          ? Promise.resolve(filteredEvents)
          : new Promise((resolve) => { releaseNewHead = resolve; });
      }
      oldHeadQueries += 1;
      return oldHeadQueries === 1
        ? Promise.resolve(oldEvents)
        : new Promise((resolve) => { releaseOldHead = resolve; });
    });
    const deps = {
      fetchPage,
      markRead: vi.fn(async (): Promise<boolean> => true),
      now: () => NOW,
      readEnabled: false,
      pageSize: 2,
      eventsChanged: {
        addListener: (listener: (message: unknown) => void) => listeners.add(listener),
        removeListener: (listener: (message: unknown) => void) => listeners.delete(listener),
      },
    };
    const { result, rerender, unmount } = renderHook(
      ({ filters, annotations }) => useEventFeed(filters, false, { ...deps, annotations }),
      { initialProps: { filters: DEFAULT_FILTERS, annotations: new Map() } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    vi.useFakeTimers();
    try {
      act(() => listeners.forEach((listener) => listener({ protocolVersion: 1, type: 'events.changed' })));
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(oldHeadQueries).toBe(2);

      rerender({ filters: { ...DEFAULT_FILTERS, chain: 'solana' }, annotations: new Map() });
      await act(async () => { await Promise.resolve(); });
      expect(result.current.status).toBe('ready');
      expect(newHeadQueries).toBe(1);

      act(() => listeners.forEach((listener) => listener({ protocolVersion: 1, type: 'events.changed' })));
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(newHeadQueries).toBe(2);
      act(() => result.current.loadMore());
      expect(historyQueries).toBe(0);

      await act(async () => { releaseOldHead(oldEvents); });
      act(() => result.current.loadMore());
      expect(historyQueries).toBe(0);
      await act(async () => { releaseNewHead(filteredEvents); });
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it('does not let a disposed head refresh clear a newer history page spinner', async () => {
    const events = [makeEvent(0), makeEvent(1)];
    const listeners = new Set<(message: unknown) => void>();
    let releaseOldHead!: (events: TradeEventV1[]) => void;
    let releaseHistory!: (events: TradeEventV1[]) => void;
    let oldHeadQueries = 0;
    const fetchPage = vi.fn((query: EventPageQuery): Promise<TradeEventV1[]> => {
      if (query.beforeId !== undefined) {
        return new Promise((resolve) => { releaseHistory = resolve; });
      }
      if (query.chain === 'solana') return Promise.resolve(events);
      oldHeadQueries += 1;
      return oldHeadQueries === 1
        ? Promise.resolve(events)
        : new Promise((resolve) => { releaseOldHead = resolve; });
    });
    const deps = {
      fetchPage,
      markRead: vi.fn(async (): Promise<boolean> => true),
      now: () => NOW,
      readEnabled: false,
      pageSize: 2,
      eventsChanged: {
        addListener: (listener: (message: unknown) => void) => listeners.add(listener),
        removeListener: (listener: (message: unknown) => void) => listeners.delete(listener),
      },
    };
    const { result, rerender, unmount } = renderHook(
      ({ filters, annotations }) => useEventFeed(filters, false, { ...deps, annotations }),
      { initialProps: { filters: DEFAULT_FILTERS, annotations: new Map() } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    vi.useFakeTimers();
    try {
      act(() => listeners.forEach((listener) => listener({ protocolVersion: 1, type: 'events.changed' })));
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      rerender({ filters: { ...DEFAULT_FILTERS, chain: 'solana' }, annotations: new Map() });
      await act(async () => { await Promise.resolve(); });
      act(() => listeners.forEach((listener) => listener({ protocolVersion: 1, type: 'events.changed' })));
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      act(() => result.current.loadMore());
      expect(result.current.loadingMore).toBe(true);

      await act(async () => { releaseOldHead(events); });
      expect(result.current.loadingMore).toBe(true);
      await act(async () => { releaseHistory([]); });
      expect(result.current.loadingMore).toBe(false);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it('releases the old head refresh lock when only annotations replace its owner', async () => {
    const events = [makeEvent(0), makeEvent(1)];
    const listeners = new Set<(message: unknown) => void>();
    let releaseOldHead!: (events: TradeEventV1[]) => void;
    let releaseHistory!: (events: TradeEventV1[]) => void;
    let headQueries = 0;
    const fetchPage = vi.fn((query: EventPageQuery): Promise<TradeEventV1[]> => {
      if (query.beforeId !== undefined) {
        return new Promise((resolve) => { releaseHistory = resolve; });
      }
      headQueries += 1;
      return headQueries === 1
        ? Promise.resolve(events)
        : new Promise((resolve) => { releaseOldHead = resolve; });
    });
    const deps = {
      fetchPage,
      markRead: vi.fn(async (): Promise<boolean> => true),
      now: () => NOW,
      readEnabled: false,
      pageSize: 2,
      eventsChanged: {
        addListener: (listener: (message: unknown) => void) => listeners.add(listener),
        removeListener: (listener: (message: unknown) => void) => listeners.delete(listener),
      },
    };
    const { result, rerender, unmount } = renderHook(
      ({ annotations }) => useEventFeed(DEFAULT_FILTERS, false, { ...deps, annotations }),
      { initialProps: { annotations: new Map() } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    vi.useFakeTimers();
    try {
      act(() => listeners.forEach((listener) => listener({ protocolVersion: 1, type: 'events.changed' })));
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(headQueries).toBe(2);
      rerender({ annotations: new Map() });
      act(() => result.current.loadMore());
      expect(result.current.loadingMore).toBe(true);

      await act(async () => { releaseOldHead(events); });
      expect(result.current.loadingMore).toBe(true);
      await act(async () => { releaseHistory([]); });
      expect(result.current.loadingMore).toBe(false);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it('defers live signals until an in-flight history page is committed', async () => {
    const events = Array.from({ length: 6 }, (_, index) => makeEvent(index));
    const fresh = makeEvent(99, { id: 'fresh', occurredAt: NOW + 1 });
    const listeners = new Set<(message: unknown) => void>();
    let releaseHistory!: (events: TradeEventV1[]) => void;
    let headQueries = 0;
    const fetchPage = vi.fn((query: EventPageQuery): Promise<TradeEventV1[]> => {
      if (query.beforeId === undefined) {
        headQueries += 1;
        return Promise.resolve(headQueries === 1 ? events.slice(0, 2) : [fresh, events[0]!]);
      }
      if (query.beforeId === events[1]?.id) {
        return new Promise((resolve) => { releaseHistory = resolve; });
      }
      return createPagedFetch(events)(query);
    });
    const deps = {
      fetchPage,
      markRead: vi.fn(async (): Promise<boolean> => true),
      annotations: new Map(),
      now: () => NOW,
      readEnabled: false,
      pageSize: 2,
      eventsChanged: {
        addListener: (listener: (message: unknown) => void) => listeners.add(listener),
        removeListener: (listener: (message: unknown) => void) => listeners.delete(listener),
      },
    };
    const { result } = renderHook(() => useEventFeed(DEFAULT_FILTERS, false, deps));
    await waitFor(() => expect(result.current.events).toHaveLength(2));
    vi.useFakeTimers();
    try {
      act(() => result.current.loadMore());
      act(() => listeners.forEach((listener) => listener({ protocolVersion: 1, type: 'events.changed' })));
      await act(async () => { await vi.advanceTimersByTimeAsync(100); });
      expect(fetchPage).toHaveBeenCalledTimes(2);

      await act(async () => { releaseHistory(events.slice(2, 4)); });
      expect(result.current.events.map((event) => event.id)).toEqual([
        'fresh', 'event-0', 'event-1', 'event-2', 'event-3',
      ]);
      act(() => result.current.loadMore());
      await act(async () => { await Promise.resolve(); });
      expect(result.current.events).toHaveLength(7);
      expect(fetchPage).toHaveBeenLastCalledWith(expect.objectContaining({ beforeId: 'event-3' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('preserves loaded history and its pagination cursor through a live head refresh', async () => {
    let events = Array.from({ length: 8 }, (_, index) => makeEvent(index));
    const listeners = new Set<(message: unknown) => void>();
    const deps = {
      fetchPage: (query: EventPageQuery) => createPagedFetch(events)(query),
      markRead: vi.fn(async (): Promise<boolean> => true),
      annotations: new Map(),
      now: () => NOW,
      pageSize: 2,
      eventsChanged: {
        addListener: (listener: (message: unknown) => void) => listeners.add(listener),
        removeListener: (listener: (message: unknown) => void) => listeners.delete(listener),
      },
    };
    const { result } = renderHook(() => useEventFeed(DEFAULT_FILTERS, false, deps));

    await waitFor(() => expect(result.current.status).toBe('ready'));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.events).toHaveLength(4));
    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.events).toHaveLength(6));

    events = [makeEvent(99, { id: 'fresh', occurredAt: NOW + 1 }), ...events];
    act(() => listeners.forEach((listener) => listener({ protocolVersion: 1, type: 'events.changed' })));
    await waitFor(() => expect(result.current.events.map((item) => item.id)).toContain('fresh'));
    expect(result.current.events).toHaveLength(7);

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.events).toHaveLength(9));
    expect(result.current.events.map((item) => item.id)).toEqual(expect.arrayContaining(['event-6', 'event-7']));
  });

  it('restarts bounded pagination when the source changes to a later-only Pump result', async () => {
    const events = [
      ...Array.from({ length: 50 }, (_, index) => makeEvent(index)),
      ...Array.from({ length: 20 }, (_, index) => makeEvent(index + 50, {
        source: 'pump',
        sources: ['pump'],
      })),
    ];
    const { result, rerender, fetchPage } = renderFeed(DEFAULT_FILTERS, events);

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.events).toHaveLength(50);

    rerender({ filters: { ...DEFAULT_FILTERS, source: 'pump' } });

    await waitFor(() => expect(result.current.events).toHaveLength(20));
    expect(result.current.events.every((event) => event.source === 'pump')).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('restarts bounded pagination when the minimum buy amount changes', async () => {
    const events = [
      ...Array.from({ length: 50 }, (_, index) => makeEvent(index, { usdAmount: 1 })),
      ...Array.from({ length: 20 }, (_, index) => makeEvent(index + 50, { usdAmount: 10 })),
    ];
    const { result, rerender, fetchPage } = renderFeed(DEFAULT_FILTERS, events);

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.events).toHaveLength(50);

    rerender({ filters: { ...DEFAULT_FILTERS, minimumBuyAmount: 5 } });

    await waitFor(() => expect(result.current.events).toHaveLength(20));
    expect(result.current.events.every((event) => event.usdAmount === 10)).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('restarts bounded pagination when the maximum buy amount changes', async () => {
    const events = [
      ...Array.from({ length: 50 }, (_, index) => makeEvent(index, { usdAmount: 10 })),
      ...Array.from({ length: 20 }, (_, index) => makeEvent(index + 50, { usdAmount: 1 })),
    ];
    const { result, rerender, fetchPage } = renderFeed(DEFAULT_FILTERS, events);

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.events).toHaveLength(50);

    rerender({ filters: { ...DEFAULT_FILTERS, maximumBuyAmount: 5 } });

    await waitFor(() => expect(result.current.events).toHaveLength(20));
    expect(result.current.events.every((event) => event.usdAmount === 1)).toBe(true);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('marks only source-eligible rendered records read', async () => {
    const events = [
      makeEvent(1, { source: 'fomo' }),
      makeEvent(2, { source: 'pump', sources: ['pump'] }),
    ];
    const { result, markRead } = renderFeed(DEFAULT_FILTERS, events, {
      canMarkRead: (event) => event.source === 'pump',
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    await waitFor(() => expect(markRead).toHaveBeenCalledWith(['event-2'], NOW));
    expect(result.current.events.find((event) => event.id === 'event-1')?.readAt).toBeUndefined();
    expect(result.current.events.find((event) => event.id === 'event-2')?.readAt).toBe(NOW);
  });
});
