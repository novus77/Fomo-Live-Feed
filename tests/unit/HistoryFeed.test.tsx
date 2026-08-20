import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChainKey, TradeEventV1 } from '../../src/domain/activity';
import type { ConnectionQueryResponse } from '../../src/messaging/protocol';
import { parseExtensionMessage } from '../../src/messaging/protocol';
import { PopupApp, type PopupDependencies } from '../../src/popup/PopupApp';
import type { PopupRuntimeLike } from '../../src/popup/popup-io';
import type { EventPageQuery } from '../../src/storage/event-repository';
import { FomoFeedDatabase } from '../../src/storage/database';
import { EventRepository } from '../../src/storage/event-repository';
import {
  DEFAULT_SETTINGS,
} from '../../src/domain/settings';
import {
  ANNOTATIONS_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  type LocalPreferencesStorage,
} from '../../src/storage/local-preferences';

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
    metricSnapshot: {
      fetchedAt: NOW,
      source: 'fomo-profile',
      pnl7d: 1250,
      winRate7d: 62.5,
    },
    ...overrides,
  };
}

interface StorageFake {
  local: LocalPreferencesStorage;
  records: Record<string, unknown>;
  onChanged: PopupDependencies['storage']['onChanged'];
  emit(changes: Record<string, unknown>): void;
}

function createStorageFake(initial: Record<string, unknown> = {}): StorageFake {
  const records: Record<string, unknown> = { ...initial };
  const listeners: Array<(changes: Record<string, unknown>, areaName: string) => void> = [];

  const local: LocalPreferencesStorage = {
    async get(keys: string[]): Promise<Record<string, unknown>> {
      const result: Record<string, unknown> = {};

      for (const key of keys) {
        if (key in records) {
          result[key] = records[key];
        }
      }

      return result;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      const changes: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(items)) {
        if (records[key] !== value) {
          changes[key] = { newValue: value };
        }
      }

      Object.assign(records, items);

      for (const listener of [...listeners]) {
        listener(changes, 'local');
      }
    },
  };

  return {
    local,
    records,
    onChanged: {
      addListener(fn: (changes: Record<string, unknown>, areaName: string) => void): void {
        listeners.push(fn);
      },
      removeListener(fn: (changes: Record<string, unknown>, areaName: string) => void): void {
        const index = listeners.indexOf(fn);

        if (index !== -1) {
          listeners.splice(index, 1);
        }
      },
    },
    emit(changes: Record<string, unknown>): void {
      for (const listener of [...listeners]) {
        listener(changes, 'local');
      }
    },
  };
}

interface RuntimeFakeOptions {
  query(query: EventPageQuery): Promise<TradeEventV1[]>;
  markRead(ids: string[], at: number): Promise<boolean>;
  connection(): ConnectionQueryResponse;
}

function createRuntimeFake(options: RuntimeFakeOptions) {
  const sent: unknown[] = [];
  const listeners: Array<(message: unknown) => void> = [];

  const runtime: PopupRuntimeLike = {
    async sendMessage(message: unknown): Promise<unknown> {
      sent.push(message);

      const parsed = parseExtensionMessage(message);

      if (!parsed.ok) {
        return undefined;
      }

      switch (parsed.message.type) {
        case 'events.query': {
          // The popup never sends search/action (they are popup-side), so
          // the transport payload is an EventPageQuery at runtime.
          const events = await options.query(
            parsed.message.payload as EventPageQuery,
          );

          return { ok: true, events };
        }
        case 'events.markRead': {
          const succeeded = await options.markRead(
            parsed.message.payload.ids,
            parsed.message.payload.at,
          );

          // An honest worker reply: ok:false when the mark was not applied,
          // so the popup's markEventsRead resolves false and the local
          // readAt must NOT be updated (NIT).
          return succeeded
            ? { ok: true, marked: parsed.message.payload.ids.length }
            : { ok: false, marked: 0 };
        }
        case 'connection.query':
          return options.connection();
        default:
          return undefined;
      }
    },
    onMessage: {
      addListener(listener: (message: unknown) => void): void {
        listeners.push(listener);
      },
      removeListener(listener: (message: unknown) => void): void {
        const index = listeners.indexOf(listener);

        if (index !== -1) {
          listeners.splice(index, 1);
        }
      },
    },
  };

  return {
    runtime,
    sent,
    // SHOULD-FIX 8: deliver a worker -> popup broadcast through the REAL
    // listener the popup registered (every old fake no-oped onMessage, so
    // the connection.changed -> re-query path was untested).
    emitMessage(message: unknown): void {
      for (const listener of [...listeners]) {
        listener(message);
      }
    },
  };
}

interface HarnessOptions {
  events?: TradeEventV1[];
  connection?: () => ConnectionQueryResponse;
  initialStorage?: Record<string, unknown>;
  markRead?: (ids: string[], at: number) => Promise<boolean>;
  copyText?: (text: string) => Promise<void>;
  query?: (query: EventPageQuery) => Promise<TradeEventV1[]>;
}

interface Harness {
  database: FomoFeedDatabase;
  repository: EventRepository;
  storage: StorageFake;
  runtime: PopupRuntimeLike;
  sent: unknown[];
  copyText: (text: string) => Promise<void>;
  container: HTMLElement;
  emitMessage(message: unknown): void;
}

const databases: FomoFeedDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
    void database.delete();
  }
});

async function renderPopup(options: HarnessOptions = {}): Promise<Harness> {
  const database = new FomoFeedDatabase('history-' + crypto.randomUUID());
  const repository = new EventRepository(database);

  databases.push(database);

  for (const event of options.events ?? []) {
    await repository.insert(event);
  }

  const storage = createStorageFake(
    options.initialStorage ?? { [SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS },
  );
  const runtimeFake = createRuntimeFake({
    query:
      options.query ??
      ((query: EventPageQuery) => repository.page(query)),
    markRead:
      options.markRead ??
      (async (ids: string[], at: number): Promise<boolean> => {
        for (const id of ids) {
          await repository.markRead(id, at);
        }

        return true;
      }),
    connection: () =>
      options.connection?.() ?? {
        ok: true,
        connected: true,
        authenticated: true,
        hasFomoTab: true,
      },
  });
  const copyText =
    options.copyText ?? vi.fn().mockResolvedValue(undefined);

  const utils = render(
    <PopupApp
      deps={{
        runtime: runtimeFake.runtime,
        storage,
        now: () => NOW,
        copyText,
      }}
    />,
  );

  return {
    database,
    repository,
    storage,
    runtime: runtimeFake.runtime,
    sent: runtimeFake.sent,
    copyText,
    container: utils.container,
    emitMessage: runtimeFake.emitMessage,
  };
}

const cardCount = (container: HTMLElement): number =>
  container.querySelectorAll('.event-card').length;

interface QuerySnapshot {
  limit: number;
  beforeOccurredAt?: number;
  beforeId?: string;
  unreadOnly?: boolean;
  chain?: ChainKey;
  traderId?: string;
  tokenAddress?: string;
}

const queryMessages = (sent: unknown[]): QuerySnapshot[] =>
  sent
    .map((message) => {
      const parsed = parseExtensionMessage(message);

      if (!parsed.ok || parsed.message.type !== 'events.query') {
        return null;
      }

      const payload = parsed.message.payload;

      return {
        limit: payload.limit,
        ...(payload.beforeOccurredAt !== undefined
          ? { beforeOccurredAt: payload.beforeOccurredAt }
          : {}),
        ...(payload.beforeId !== undefined ? { beforeId: payload.beforeId } : {}),
        ...(payload.unreadOnly !== undefined
          ? { unreadOnly: payload.unreadOnly }
          : {}),
        ...(payload.chain !== undefined ? { chain: payload.chain } : {}),
        ...(payload.traderId !== undefined ? { traderId: payload.traderId } : {}),
        ...(payload.tokenAddress !== undefined
          ? { tokenAddress: payload.tokenAddress }
          : {}),
      };
    })
    .filter((snapshot): snapshot is QuerySnapshot => snapshot !== null);


describe('popup top-level states', () => {
  it('shows the login-required banner with a link to Fomo when a Fomo tab exists but nothing is connected', async () => {
    const { container } = await renderPopup({
      connection: () => ({ ok: true, connected: false, authenticated: false, hasFomoTab: true }),
    });

    const banner = await screen.findByText(/log in to fomo/i);

    expect(banner).toBeInTheDocument();

    const link = screen.getByRole('link', { name: /open fomo/i });

    expect(link).toHaveAttribute('href', 'https://fomo.family/');
  });

  it('shows the Fomo-tab-offline banner when no Fomo tab exists', async () => {
    const { container } = await renderPopup({
      connection: () => ({ ok: true, connected: false, authenticated: false, hasFomoTab: false }),
    });

    await screen.findByText(/fomo tab offline/i);

    expect(container.querySelector('.popup-feed')).not.toBeNull();
  });

  it('shows the reconnecting banner when authenticated but every socket is closed', async () => {
    const { container } = await renderPopup({
      connection: () => ({ ok: true, connected: false, authenticated: true, hasFomoTab: true }),
    });

    await screen.findByText(/fomo reconnecting/i);

    expect(container.querySelector('.popup-feed')).not.toBeNull();
  });

  it('shows the connected-empty state when connected with no history', async () => {
    const { container } = await renderPopup({
      connection: () => ({ ok: true, connected: true, authenticated: true, hasFomoTab: true }),
    });

    await screen.findByText(/no activity yet/i);

    expect(container.querySelector('.popup-feed')).not.toBeNull();
  });

  it('shows the connected-with-history feed when events exist', async () => {
    const { container } = await renderPopup({
      events: [makeEvent()],
      connection: () => ({ ok: true, connected: true, authenticated: true, hasFomoTab: true }),
    });

    expect(await screen.findByText('Alpha Whale')).toBeInTheDocument();
    expect(container.querySelector('.popup-feed')).not.toBeNull();
  });

  it('renders untrusted history values as text, never as markup', async () => {
    await renderPopup({
      events: [makeEvent({ traderName: '<img src=x onerror=alert(1)>' })],
      connection: () => ({ ok: true, connected: true, authenticated: true, hasFomoTab: true }),
    });

    expect(
      await screen.findByText('<img src=x onerror=alert(1)>'),
    ).toBeInTheDocument();
    expect(document.querySelector('img[src=x]')).toBeNull();
  });
});

describe('feed pagination', () => {
  it('loads the first 50 rows and paginates with the cursor on demand', async () => {
    const events = Array.from({ length: 120 }, (_, index) =>
      makeEvent({ id: 'fomo:event-' + index, occurredAt: NOW - index }),
    );
    const { container, sent } = await renderPopup({ events });

    await waitFor(() => expect(cardCount(container)).toBe(50));

    const initialQuery = queryMessages(sent)[0];

    expect(initialQuery).toMatchObject({ limit: 50 });
    expect(initialQuery?.beforeOccurredAt).toBeUndefined();

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));

    await waitFor(() => expect(cardCount(container)).toBe(100));

    const secondQuery = queryMessages(sent)[1];

    expect(secondQuery).toMatchObject({
      beforeOccurredAt: events[49]?.occurredAt,
      beforeId: events[49]?.id,
    });

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));

    await waitFor(() => expect(cardCount(container)).toBe(120));

    expect(screen.queryByRole('button', { name: /load more/i })).not.toBeInTheDocument();
  });
});

describe('feed filters', () => {
  it('executes the unread-only filter through the storage query', async () => {
    const events = [
      makeEvent({ id: 'unread-1' }),
      makeEvent({ id: 'read-1', readAt: NOW - 1000 }),
      makeEvent({ id: 'unread-2', occurredAt: NOW - 2000 }),
    ];
    const { container, sent } = await renderPopup({
      events,
      // A mark-read that never settles keeps the visible unread rows in the
      // filtered view so the test asserts what the filter QUERY did, without
      // racing the read-state removal.
      markRead: () => new Promise(() => {}),
    });

    await waitFor(() => expect(cardCount(container)).toBe(3));

    fireEvent.click(screen.getByRole('checkbox', { name: /unread only/i }));

    await waitFor(() => expect(cardCount(container)).toBe(2));
    expect(screen.queryByText('read-1')).toBeNull();

    const queries = queryMessages(sent);
    const unreadQuery = queries[queries.length - 1];

    expect(unreadQuery).toMatchObject({ unreadOnly: true });
  });

  it('applies the action filter as a popup-side post-filter', async () => {
    const events = [
      makeEvent({ id: 'buy-1', action: 'buy' }),
      makeEvent({ id: 'sell-1', action: 'sell', occurredAt: NOW - 1000 }),
    ];
    const { container, sent } = await renderPopup({ events });

    await waitFor(() => expect(cardCount(container)).toBe(2));

    fireEvent.change(screen.getByRole('combobox', { name: /action/i }), {
      target: { value: 'sell' },
    });

    await waitFor(() => expect(cardCount(container)).toBe(1));
    expect(screen.queryByText('buy-1')).toBeNull();

    const queries = queryMessages(sent);
    const lastQuery = queries[queries.length - 1];

    // Action has no IndexedDB index: the storage query never carries it.
    expect(lastQuery).not.toHaveProperty('action');
  });

  it('executes the chain filter through the storage query', async () => {
    const events = [
      makeEvent({ id: 'bsc-1', chain: 'bsc' }),
      makeEvent({ id: 'sol-1', chain: 'solana', tokenAddress: 'So11111111111111111111111111111111111111112', occurredAt: NOW - 1000 }),
    ];
    const { container, sent } = await renderPopup({ events });

    await waitFor(() => expect(cardCount(container)).toBe(2));

    fireEvent.change(screen.getByRole('combobox', { name: /chain/i }), {
      target: { value: 'solana' },
    });

    await waitFor(() => expect(cardCount(container)).toBe(1));
    expect(screen.queryByText('bsc-1')).toBeNull();

    const queries = queryMessages(sent);
    const lastQuery = queries[queries.length - 1];

    expect(lastQuery).toMatchObject({ chain: 'solana' });
  });

  it('executes the trader filter through the storage query', async () => {
    const events = [
      makeEvent({ id: 'alpha-1', traderId: 'trader-1', traderHandle: 'alpha' }),
      makeEvent({ id: 'beta-1', traderId: 'trader-2', traderHandle: 'beta', occurredAt: NOW - 1000 }),
    ];
    const { container, sent } = await renderPopup({ events });

    await waitFor(() => expect(cardCount(container)).toBe(2));

    fireEvent.change(screen.getByRole('combobox', { name: /trader/i }), {
      target: { value: 'trader-2' },
    });

    await waitFor(() => expect(cardCount(container)).toBe(1));
    expect(screen.queryByText('alpha-1')).toBeNull();

    const queries = queryMessages(sent);
    const lastQuery = queries[queries.length - 1];

    expect(lastQuery).toMatchObject({ traderId: 'trader-2' });
  });

  it('executes the token filter through the storage query by exact address', async () => {
    const otherAddress = '0x0000000000000000000000000000000000000001';
    const events = [
      makeEvent({ id: 'fomo-1' }),
      makeEvent({ id: 'other-1', tokenAddress: otherAddress, occurredAt: NOW - 1000 }),
    ];
    const { container, sent } = await renderPopup({ events });

    await waitFor(() => expect(cardCount(container)).toBe(2));

    fireEvent.change(screen.getByRole('combobox', { name: /token/i }), {
      target: { value: otherAddress },
    });

    await waitFor(() => expect(cardCount(container)).toBe(1));
    expect(screen.queryByText('fomo-1')).toBeNull();

    const queries = queryMessages(sent);
    const lastQuery = queries[queries.length - 1];

    expect(lastQuery).toMatchObject({ tokenAddress: otherAddress });
  });
});

describe('feed search', () => {
  it('filters by trader handle, display name, symbol, address, and annotation label', async () => {
    const events = [
      makeEvent({ id: 'alpha-1', traderId: 'trader-1', traderHandle: 'alpha', traderName: 'Alpha Whale' }),
      makeEvent({
        id: 'beta-1',
        traderId: 'trader-2',
        traderHandle: 'beta',
        traderName: 'Beta Trader',
        tokenAddress: '0x0000000000000000000000000000000000000001',
        occurredAt: NOW - 1000,
      }),
    ];
    const { container } = await renderPopup({
      events,
      initialStorage: {
        [SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS,
        [ANNOTATIONS_STORAGE_KEY]: {
          'trader-2': { traderId: 'trader-2', label: 'Whale Watch', updatedAt: 1 },
        },
      },
    });

    await waitFor(() => expect(cardCount(container)).toBe(2));

    const searchInput = screen.getByLabelText(/search history/i);

    fireEvent.change(searchInput, { target: { value: 'alpha' } });
    await waitFor(() => expect(cardCount(container)).toBe(1));
    expect(screen.queryByText('beta-1')).toBeNull();

    fireEvent.change(searchInput, { target: { value: 'whale watch' } });
    await waitFor(() => expect(cardCount(container)).toBe(1));
    expect(screen.queryByText('alpha-1')).toBeNull();

    fireEvent.change(searchInput, { target: { value: '020bfc65' } });
    await waitFor(() => expect(cardCount(container)).toBe(1));
    expect(screen.queryByText('beta-1')).toBeNull();
  });

  it('keeps paginating across fully-filtered pages until matches are found or data is exhausted', async () => {
    const events = Array.from({ length: 120 }, (_, index) => {
      if (index >= 117) {
        return makeEvent({
          id: 'deep-' + index,
          traderHandle: 'zzz-alpha',
          occurredAt: NOW - index,
        });
      }

      return makeEvent({
        id: 'plain-' + index,
        traderHandle: 'alpha',
        occurredAt: NOW - index,
      });
    });
    const { container, sent } = await renderPopup({ events });

    await waitFor(() => expect(cardCount(container)).toBe(50));

    fireEvent.change(screen.getByLabelText(/search history/i), {
      target: { value: 'zzz' },
    });

    // All 3 deep matches are found even though the first pages contained none.
    await waitFor(() => expect(cardCount(container)).toBe(3));
    expect(
      container.querySelectorAll('.event-card[data-event-id^="deep-"]'),
    ).toHaveLength(3);
    expect(queryMessages(sent).length).toBeGreaterThan(1);
  });

  it('shows the empty message when search matches nothing', async () => {
    const { container } = await renderPopup({
      events: [makeEvent()],
    });

    await waitFor(() => expect(cardCount(container)).toBe(1));

    fireEvent.change(screen.getByLabelText(/search history/i), {
      target: { value: 'does-not-exist' },
    });

    // The reload briefly shows the loading state, then the ready empty state.
    await waitFor(() => expect(cardCount(container)).toBe(0));
    expect(await screen.findByText(/no activity yet/i)).toBeInTheDocument();
  });
});

describe('read state', () => {
  it('marks the visible unread rows read after rendering and never marks unseen rows', async () => {
    const events = Array.from({ length: 55 }, (_, index) =>
      makeEvent({ id: 'fomo:event-' + index, occurredAt: NOW - index }),
    );
    const { repository, sent } = await renderPopup({ events });

    const markReadMessages = (): Array<{ ids: string[]; at: number }> =>
      sent
        .map((message) => {
          const parsed = parseExtensionMessage(message);

          return parsed.ok && parsed.message.type === 'events.markRead'
            ? parsed.message.payload
            : null;
        })
        .filter(
          (payload): payload is NonNullable<typeof payload> => payload !== null,
        );

    await waitFor(() => expect(markReadMessages().length).toBeGreaterThan(0));

    const markReadCalls = markReadMessages();
    const firstCall = markReadCalls[0];

    expect(firstCall).toBeDefined();
    expect(firstCall?.ids).toHaveLength(50);
    expect(firstCall?.ids[0]).toBe('fomo:event-0');
    expect(firstCall?.ids).toContain('fomo:event-49');
    expect(firstCall?.ids).not.toContain('fomo:event-50');

    // The 51st row was never rendered, so it must remain unread.
    expect((await repository.get('fomo:event-50'))?.readAt).toBeUndefined();

    // The first visible row was marked read with the injected clock.
    expect((await repository.get('fomo:event-0'))?.readAt).toBe(NOW);
  });
});

describe('pinned-first sorting', () => {
  it('only sorts pinned traders first when the toggle is enabled', async () => {
    const events = [
      makeEvent({ id: 'newer', traderId: 'trader-1', traderHandle: 'alpha', occurredAt: NOW - 1000 }),
      makeEvent({ id: 'older-pinned', traderId: 'trader-2', traderHandle: 'beta', occurredAt: NOW - 5000 }),
    ];
    const { container } = await renderPopup({
      events,
      initialStorage: {
        [SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS,
        [ANNOTATIONS_STORAGE_KEY]: {
          'trader-2': { traderId: 'trader-2', pinned: true, updatedAt: 1 },
        },
      },
    });

    await waitFor(() => expect(cardCount(container)).toBe(2));

    const cards = () => Array.from(container.querySelectorAll('.event-card'));

    expect(cards()[0]?.getAttribute('data-event-id')).toBe('newer');

    fireEvent.click(screen.getByRole('checkbox', { name: /pinned first/i }));

    await waitFor(() => {
      expect(cards()[0]?.getAttribute('data-event-id')).toBe('older-pinned');
    });
  });
});

describe('history card content and actions', () => {
  it('shows the same fields as the toast plus read state', async () => {
    const { container } = await renderPopup({
      events: [makeEvent()],
    });

    await waitFor(() => expect(cardCount(container)).toBe(1));

    const card = container.querySelector('.event-card') as HTMLElement | null;

    if (card === null) {
      throw new Error('missing event card');
    }

    expect(within(card).getByText('Alpha Whale')).toBeInTheDocument();
    expect(within(card).getByText('@alpha')).toBeInTheDocument();
    expect(within(card).getByText('Buy')).toBeInTheDocument();
    expect(within(card).getByText('$FOMO')).toBeInTheDocument();
    expect(within(card).getByText('BSC')).toBeInTheDocument();
    expect(within(card).getByText('$1.25K')).toBeInTheDocument();
    expect(within(card).getByText('1m ago')).toBeInTheDocument();
    expect(within(card).getByText('7d PnL')).toBeInTheDocument();
    expect(within(card).getByText('+$1.25K')).toBeInTheDocument();
  });

  it('copies the complete validated address from the card', async () => {
    const copyText = vi.fn().mockResolvedValue(undefined);
    const { container } = await renderPopup({
      events: [makeEvent()],
      copyText,
    });

    await waitFor(() => expect(cardCount(container)).toBe(1));

    const card = container.querySelector('.event-card') as HTMLElement | null;

    if (card === null) {
      throw new Error('missing event card');
    }

    const copyButton = within(card).getByRole('button', {
      name: /copy full address/i,
    });

    fireEvent.click(copyButton);

    expect(copyText).toHaveBeenCalledWith(TOKEN_ADDRESS);
  });

  it('links the trader identity to the verified profile page', async () => {
    const { container } = await renderPopup({
      events: [makeEvent()],
    });

    await waitFor(() => expect(cardCount(container)).toBe(1));

    const card = container.querySelector('.event-card') as HTMLElement | null;

    if (card === null) {
      throw new Error('missing event card');
    }

    const link = within(card).getByRole('link', { name: /alpha whale/i });

    expect(link).toHaveAttribute('href', 'https://fomo.family/user/alpha');
  });

  it('renders Unavailable metrics, never zero', async () => {
    const event = makeEvent({
      metricSnapshot: { fetchedAt: NOW, source: 'fomo-profile', winRate7d: 62.5 },
    });
    const { container } = await renderPopup({
      events: [event],
      initialStorage: {
        [SETTINGS_STORAGE_KEY]: {
          ...DEFAULT_SETTINGS,
          metrics: { primary: 'pnl7d' },
        },
      },
    });

    await waitFor(() => expect(cardCount(container)).toBe(1));

    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });
});

describe('BLOCKING 1: read marking is gated on the connected state', () => {
  const markReadPayloads = (sent: unknown[]): Array<{ ids: string[]; at: number }> =>
    sent
      .map((message) => {
        const parsed = parseExtensionMessage(message);

        return parsed.ok && parsed.message.type === 'events.markRead'
          ? parsed.message.payload
          : null;
      })
      .filter(
        (payload): payload is NonNullable<typeof payload> => payload !== null,
      );

  it('marks NOTHING read when the popup opens in the offline state', async () => {
    const events = Array.from({ length: 3 }, (_, index) =>
      makeEvent({ id: 'fomo:event-' + index, occurredAt: NOW - index }),
    );
    const { repository, sent, container } = await renderPopup({
      events,
      connection: () => ({ ok: true, connected: false, authenticated: false, hasFomoTab: false }),
    });

    // The stored history renders READ-ONLY below the banner...
    await waitFor(() => expect(cardCount(container)).toBe(3));
    await screen.findByText(/fomo tab offline/i);

    // ...but not a single events.markRead message may be sent, so every row
    // stays unread and the badge is untouched for rows the user never saw in
    // a live session.
    expect(markReadPayloads(sent)).toEqual([]);
    expect((await repository.get('fomo:event-0'))?.readAt).toBeUndefined();
    expect((await repository.get('fomo:event-2'))?.readAt).toBeUndefined();
  });

  it('marks NOTHING read when the popup opens in the login-required state', async () => {
    const events = Array.from({ length: 3 }, (_, index) =>
      makeEvent({ id: 'fomo:event-' + index, occurredAt: NOW - index }),
    );
    const { repository, sent, container } = await renderPopup({
      events,
      connection: () => ({ ok: true, connected: false, authenticated: false, hasFomoTab: true }),
    });

    await waitFor(() => expect(cardCount(container)).toBe(3));
    await screen.findByText(/log in to fomo/i);

    expect(markReadPayloads(sent)).toEqual([]);
    expect((await repository.get('fomo:event-0'))?.readAt).toBeUndefined();
  });

  it('marks NOTHING read when the popup opens in the reconnecting state', async () => {
    const events = [makeEvent({ id: 'fomo:event-0' })];
    const { repository, sent, container } = await renderPopup({
      events,
      connection: () => ({ ok: true, connected: false, authenticated: true, hasFomoTab: true }),
    });

    await waitFor(() => expect(cardCount(container)).toBe(1));
    await screen.findByText(/fomo reconnecting/i);

    expect(markReadPayloads(sent)).toEqual([]);
    expect((await repository.get('fomo:event-0'))?.readAt).toBeUndefined();
  });

  it('still marks the RENDERED rows read in the connected state', async () => {
    const events = Array.from({ length: 3 }, (_, index) =>
      makeEvent({ id: 'fomo:event-' + index, occurredAt: NOW - index }),
    );
    const { repository, sent } = await renderPopup({ events });

    await waitFor(() => expect(markReadPayloads(sent).length).toBeGreaterThan(0));

    expect(markReadPayloads(sent)[0]?.ids).toEqual(['fomo:event-0', 'fomo:event-1', 'fomo:event-2']);
    expect((await repository.get('fomo:event-0'))?.readAt).toBe(NOW);
  });
});

describe('SHOULD-FIX 8: connection.changed re-queries while the popup is open', () => {
  it('flips from connected to reconnecting when the worker reports the socket closed', async () => {
    let verdict: ConnectionQueryResponse = {
      ok: true,
      connected: true,
      authenticated: true,
      hasFomoTab: true,
    };
    const { emitMessage, container } = await renderPopup({
      events: [makeEvent()],
      connection: () => verdict,
    });

    await waitFor(() => expect(cardCount(container)).toBe(1));
    expect(screen.queryByText(/fomo reconnecting/i)).toBeNull();

    // The socket closes while the popup stays open: the worker now answers
    // authenticated-but-disconnected, and the popup re-queries on the
    // connection.changed broadcast through the REAL listener.
    verdict = { ok: true, connected: false, authenticated: true, hasFomoTab: true };

    emitMessage({
      protocolVersion: 1,
      type: 'connection.changed',
      payload: { connected: false, authenticated: true, at: NOW },
    });

    expect(await screen.findByText(/fomo reconnecting/i)).toBeInTheDocument();
  });

  it('flips to offline when the worker reports the Fomo tab is gone', async () => {
    let verdict: ConnectionQueryResponse = {
      ok: true,
      connected: true,
      authenticated: true,
      hasFomoTab: true,
    };
    const { emitMessage } = await renderPopup({
      connection: () => verdict,
    });

    await screen.findByText(/no activity yet/i);

    verdict = { ok: true, connected: false, authenticated: false, hasFomoTab: false };

    emitMessage({
      protocolVersion: 1,
      type: 'connection.changed',
      payload: { connected: false, authenticated: false, at: NOW },
    });

    expect(await screen.findByText(/fomo tab offline/i)).toBeInTheDocument();
  });
});

describe('failed first load (NIT)', () => {
  it('renders an error with a working retry instead of the empty-state message', async () => {
    let fail = true;
    const database = new FomoFeedDatabase('error-' + crypto.randomUUID());
    const repository = new EventRepository(database);

    databases.push(database);

    await repository.insert(makeEvent());

    const storage = createStorageFake({ [SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS });
    const runtimeFake = createRuntimeFake({
      query: async () => {
        if (fail) {
          throw new Error('worker suspended');
        }

        return repository.page({ limit: 50 });
      },
      markRead: async () => true,
      connection: () => ({ ok: true, connected: true, authenticated: true, hasFomoTab: true }),
    });

    const { container } = render(
      <PopupApp deps={{ runtime: runtimeFake.runtime, storage, now: () => NOW }} />,
    );

    // First load failed: an explicit error + retry, never "No activity yet".
    expect(await screen.findByText(/history could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByText(/no activity yet/i)).toBeNull();

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => expect(cardCount(container)).toBe(1));
  });
});

describe('image source allowlist (NIT)', () => {
  it('renders the initials fallback instead of a non-https avatar image', async () => {
    const { container } = await renderPopup({
      events: [
        makeEvent({
          traderAvatarUrl: 'http://evil.example/avatar.png',
          traderName: 'Alpha Whale',
        }),
      ],
    });

    await waitFor(() => expect(cardCount(container)).toBe(1));

    const card = container.querySelector('.event-card') as HTMLElement | null;

    if (card === null) {
      throw new Error('missing event card');
    }

    // The initials fallback rendered (Alpha -> 'AW') and NO <img> with the
    // non-https source exists anywhere.
    expect(card.querySelector('.event-avatar')).toHaveTextContent('AW');
    expect(container.querySelector('img[src^="http:"]')).toBeNull();
  });

  it('still renders a valid https avatar image', async () => {
    const { container } = await renderPopup({
      events: [
        makeEvent({ traderAvatarUrl: 'https://cdn.example/avatar.png' }),
      ],
    });

    await waitFor(() => expect(cardCount(container)).toBe(1));

    expect(container.querySelector('img[src="https://cdn.example/avatar.png"]')).not.toBeNull();
  });
});

describe('NIT: read-marking honesty and search-filtered dropdowns', () => {
  it('never updates the local readAt when the worker markRead fails', async () => {
    const { container } = await renderPopup({
      events: [makeEvent({ id: 'fomo:event-0' })],
      markRead: async () => false,
    });

    await waitFor(() => expect(cardCount(container)).toBe(1));

    // The card stays UNREAD (no local lie): read styling remains until the
    // worker actually confirms a mark.
    const card = container.querySelector('.event-card') as HTMLElement | null;

    if (card === null) {
      throw new Error('missing event card');
    }

    expect(card.className).toContain('event-card-unread');
  });

  it('excludes search-filtered traders from the trader dropdown (NIT)', async () => {
    const { container } = await renderPopup({
      events: [
        makeEvent({ id: 'alpha-1', traderId: 'trader-1', traderHandle: 'alpha' }),
        makeEvent({
          id: 'beta-1',
          traderId: 'trader-2',
          traderHandle: 'beta',
          traderName: 'Beta Trader',
          occurredAt: NOW - 1000,
        }),
      ],
    });

    await waitFor(() => expect(cardCount(container)).toBe(2));

    fireEvent.change(screen.getByLabelText(/search history/i), {
      target: { value: 'alpha' },
    });

    await waitFor(() => expect(cardCount(container)).toBe(1));

    const traderSelect = screen.getByRole('combobox', { name: /trader filter/i });
    const options = Array.from(traderSelect.querySelectorAll('option')).map(
      (option) => option.textContent ?? '',
    );

    // The hidden 'beta' trader is no longer offered as a filter target.
    expect(options).toContain('@alpha');
    expect(options).not.toContain('@beta');
    expect(container.querySelector('.popup-feed')).not.toBeNull();
  });
});
