import 'fake-indexeddb/auto';

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TradeEventV1 } from '../../src/domain/activity';
import { DEFAULT_FILTERS } from '../../src/popup/event-query';
import { useEventFeed } from '../../src/popup/use-event-feed';
import { FomoFeedDatabase } from '../../src/storage/database';
import { EventRepository, type EventPageQuery } from '../../src/storage/event-repository';

const NOW = 1_800_000_000_000;
const databases: FomoFeedDatabase[] = [];
const eventAt = (index: number): TradeEventV1 => ({
  schemaVersion: 1, id: `fomo:row-${index}`, source: 'fomo',
  traderId: 'trader-1', traderHandle: 'alpha', chain: 'bsc',
  tokenAddress: '0x020bfc650a365f8bb26819deaabf3e21291018b4', tokenSymbol: 'COIN',
  action: 'buy', occurredAt: NOW - index, receivedAt: NOW,
});

afterEach(async () => {
  await Promise.all(databases.splice(0).map(async (database) => {
    database.close();
    await database.delete();
  }));
});

describe('useEventFeed physical scan continuation', () => {
  it('resumes real sparse unread history and marks only the revealed eligible match', async () => {
    const database = new FomoFeedDatabase('scan-feed-' + crypto.randomUUID());
    databases.push(database);
    const readRows = Array.from({ length: 650 }, (_, index) => ({ ...eventAt(index), readAt: NOW - 1 }));
    const unread = eventAt(650);
    await database.events.bulkAdd([...readRows, unread]);
    const repository = new EventRepository(database);
    const fetchPage = vi.fn((query: EventPageQuery) => repository.scanPage(query));
    const markRead = vi.fn(async (ids: readonly string[], at: number) => {
      for (const id of ids) await repository.markRead(id, at);
      return true;
    });
    const deps = { fetchPage, markRead, annotations: new Map(), now: () => NOW };
    const filters = { ...DEFAULT_FILTERS, unreadOnly: true };
    const { result, unmount } = renderHook(() => useEventFeed(filters, false, deps));
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.events).toEqual([]);
    expect(result.current).toMatchObject({ scanExceeded: true, hasMore: true });
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(markRead).not.toHaveBeenCalled();

    act(() => result.current.loadMore());
    await waitFor(() => expect(result.current.events.map((event) => event.id)).toEqual([unread.id]));
    await waitFor(() => expect(result.current.events[0]?.readAt).toBe(NOW));
    expect(result.current).toMatchObject({ scanExceeded: false, hasMore: false, loadingMore: false });
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(fetchPage.mock.calls[1]?.[0]).toMatchObject({ beforeOccurredAt: NOW - 499, beforeId: 'fomo:row-499' });
    expect(markRead).toHaveBeenCalledExactlyOnceWith([unread.id], NOW);
    expect((await repository.get(readRows[0]!.id))?.readAt).toBe(NOW - 1);
    expect((await repository.get(unread.id))?.readAt).toBe(NOW);
    unmount();
  });
});
