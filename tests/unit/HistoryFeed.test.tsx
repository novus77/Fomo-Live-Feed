import 'fake-indexeddb/auto';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChainKey, TradeEventV1 } from '../../src/domain/activity';
import type { ConnectionQueryResponse } from '../../src/messaging/protocol';
import { parseExtensionMessage } from '../../src/messaging/protocol';
import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import { PopupApp, type PopupDependencies } from '../../src/popup/PopupApp';
import { HistoryFeed } from '../../src/popup/HistoryFeed';
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
import type {
  BrowserTranslationApi,
  TranslatorSession,
} from '../../src/translation/browser-translation';
import { OpinionTranslationCoordinator } from '../../src/translation/opinion-translation';

// Side-panel strings render through useLocale; the real provider is covered
// by LocaleProvider.test.tsx, so this harness substitutes a stable EN catalog
// and keeps every assertion synchronous.
vi.mock('../../src/i18n/LocaleProvider', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/i18n/LocaleProvider')>();
  const { translate: translateMessage } = await import('../../src/i18n/catalog');

  const useLocale = (): LocaleContextValue => ({
    locale: 'en',
    setLocale: () => {},
    translate: (key, values) => translateMessage('en', key, values),
  });

  return { ...actual, useLocale };
});

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
  unmount(): void;
  emitMessage(message: unknown): void;
}

const databases: FomoFeedDatabase[] = [];

afterEach(() => {
  vi.useRealTimers();
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
    unmount: utils.unmount,
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


describe('HistoryFeed translation coordinator sharing', () => {
  it('forwards one shared coordinator to every card so one session serves all theses', async () => {
    const events = [
      makeEvent({ id: 'thesis-1', thesis: 'Rotation into L1s' }),
      makeEvent({ id: 'thesis-2', thesis: 'Chasing hot wallets' }),
    ];
    const detect = vi.fn(async () => ({ language: 'es', confidence: 0.99 }));
    const availability = vi.fn(async () => 'available' as const);
    const create = vi.fn(
      async (_source: string, _target: string): Promise<TranslatorSession> => ({
        translate: async (text: string) => `[translated] ${text}`,
        destroy: () => {},
      }),
    );
    const api = { detect, availability, create } as unknown as BrowserTranslationApi;
    const coordinator = new OpinionTranslationCoordinator({
      api,
      browserLanguage: () => 'en',
    });

    render(
      <HistoryFeed
        events={events}
        status="ready"
        hasMore={false}
        loadingMore={false}
        scanExceeded={false}
        noChainsSelected={false}
        settings={DEFAULT_SETTINGS}
        annotations={new Map()}
        now={() => NOW}
        copyText={vi.fn().mockResolvedValue(undefined)}
        openLink={vi.fn()}
        translationCoordinator={coordinator}
        onLoadMore={vi.fn()}
        onRetry={vi.fn()}
        onSelectAllChains={vi.fn()}
        onUpsertAnnotation={vi.fn()}
        onDeleteAnnotation={vi.fn()}
      />,
    );

    expect(await screen.findByText('[translated] Rotation into L1s')).toBeInTheDocument();
    expect(await screen.findByText('[translated] Chasing hot wallets')).toBeInTheDocument();

    // Both cards share the ONE panel coordinator: the shared es->en pair
    // needs exactly one session.
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('HistoryFeed chain empty state', () => {
  it('shows an explicit recovery action when every chain is disabled', () => {
    const onSelectAllChains = vi.fn();

    render(
      <HistoryFeed
        events={[]}
        status="ready"
        hasMore={false}
        loadingMore={false}
        scanExceeded={false}
        noChainsSelected
        settings={DEFAULT_SETTINGS}
        annotations={new Map()}
        now={() => NOW}
        copyText={vi.fn().mockResolvedValue(undefined)}
        openLink={vi.fn()}
        onLoadMore={vi.fn()}
        onRetry={vi.fn()}
        onSelectAllChains={onSelectAllChains}
        onUpsertAnnotation={vi.fn()}
        onDeleteAnnotation={vi.fn()}
      />,
    );

    expect(screen.getByText('No chains selected.')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveClass('feed-state-empty');
    fireEvent.click(screen.getByRole('button', { name: 'Select all chains' }));
    expect(onSelectAllChains).toHaveBeenCalledTimes(1);
  });

  it('keeps loading and error states ahead of the chain empty state', () => {
    const common = {
      events: [],
      hasMore: false,
      loadingMore: false,
      scanExceeded: false,
      noChainsSelected: true,
      settings: DEFAULT_SETTINGS,
      annotations: new Map(),
      now: () => NOW,
      copyText: vi.fn().mockResolvedValue(undefined),
      openLink: vi.fn(),
      onLoadMore: vi.fn(),
      onRetry: vi.fn(),
      onSelectAllChains: vi.fn(),
      onUpsertAnnotation: vi.fn(),
      onDeleteAnnotation: vi.fn(),
    } as const;
    const { rerender } = render(<HistoryFeed {...common} status="loading" />);

    expect(screen.getByText('Loading history…')).toBeInTheDocument();
    expect(document.querySelectorAll('.feed-skeleton-card')).toHaveLength(3);
    expect(screen.queryByText('No chains selected.')).not.toBeInTheDocument();

    rerender(<HistoryFeed {...common} status="error" />);
    expect(screen.getByRole('alert')).toHaveTextContent('History could not be loaded');
    expect(screen.getByRole('alert')).toHaveClass('feed-state-error');
    expect(screen.queryByText('No chains selected.')).not.toBeInTheDocument();
  });
});

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

  it('discards an old load-more completion after an events.changed reload', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) =>
      makeEvent({ id: `initial-${index}`, occurredAt: NOW - index }),
    );
    const stalePage = Array.from({ length: 50 }, (_, index) =>
      makeEvent({ id: `stale-${index}`, tokenSymbol: 'STALE', occurredAt: NOW - 100 - index }),
    );
    const freshPage = Array.from({ length: 50 }, (_, index) =>
      makeEvent({ id: `fresh-${index}`, tokenSymbol: 'FRESH', occurredAt: NOW + 100 - index }),
    );
    const observedQueries: EventPageQuery[] = [];
    let queryCount = 0;
    let resolveLoadMore: ((events: TradeEventV1[]) => void) | undefined;
    let resolveLiveRefresh: ((events: TradeEventV1[]) => void) | undefined;
    const { container, emitMessage } = await renderPopup({
      query: async (query) => {
        observedQueries.push(query);
        queryCount += 1;
        if (queryCount === 1) return firstPage;
        if (queryCount === 2) {
          return new Promise<TradeEventV1[]>((resolve) => { resolveLoadMore = resolve; });
        }
        if (queryCount === 3) {
          return new Promise<TradeEventV1[]>((resolve) => { resolveLiveRefresh = resolve; });
        }
        return [];
      },
    });
    await act(async () => { await Promise.resolve(); });
    expect(cardCount(container)).toBe(50);

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(resolveLoadMore).toBeDefined());
    act(() => emitMessage({ protocolVersion: 1, type: 'events.changed' }));
    await waitFor(() => expect(queryCount).toBe(3));
    const blockedLoadMore = screen.getByRole('button', { name: /loading more/i });
    expect(blockedLoadMore).toBeDisabled();
    fireEvent.click(blockedLoadMore);
    expect(queryCount).toBe(3);

    await act(async () => { resolveLiveRefresh?.(freshPage); await Promise.resolve(); });
    expect(await screen.findAllByText('$FRESH')).toHaveLength(50);

    await act(async () => { resolveLoadMore?.(stalePage); await Promise.resolve(); });
    expect(screen.queryByText('$FOMO')).toBeNull();
    expect(screen.queryByText('$STALE')).toBeNull();
    expect(cardCount(container)).toBe(50);

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(queryCount).toBe(4));
    expect(observedQueries[3]).toMatchObject({
      beforeOccurredAt: freshPage[49]?.occurredAt,
      beforeId: freshPage[49]?.id,
    });
  });

  it('keeps ready rows visible and converges when a live query is slower than max wait', async () => {
    const initial = makeEvent({ id: 'initial', tokenSymbol: 'INITIAL' });
    const fresh = makeEvent({ id: 'fresh', tokenSymbol: 'FRESH' });
    const latest = makeEvent({ id: 'latest', tokenSymbol: 'LATEST' });
    const pending: Array<(events: TradeEventV1[]) => void> = [];
    let queryCount = 0;
    const { emitMessage } = await renderPopup({
      query: async () => {
        queryCount += 1;
        if (queryCount === 1) return [initial];
        return new Promise<TradeEventV1[]>((resolve) => pending.push(resolve));
      },
    });
    expect(await screen.findByText('$INITIAL')).toBeInTheDocument();
    vi.useFakeTimers();

    for (let elapsed = 0; elapsed < 600; elapsed += 40) {
      act(() => emitMessage({ protocolVersion: 1, type: 'events.changed' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(40); });
      expect(screen.queryByText(/loading history/i)).toBeNull();
      expect(screen.getByText('$INITIAL')).toBeInTheDocument();
    }

    expect(pending).toHaveLength(1);
    await act(async () => { pending[0]?.([fresh]); await Promise.resolve(); });
    expect(screen.getByText('$FRESH')).toBeInTheDocument();
    await act(async () => { await Promise.resolve(); });
    expect(pending).toHaveLength(2);
    await act(async () => { pending[1]?.([latest]); await Promise.resolve(); });
    expect(screen.getByText('$LATEST')).toBeInTheDocument();
    vi.useRealTimers();
  });

  it('preserves coherent pagination when a live refresh fails', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) =>
      makeEvent({ id: `old-${index}`, occurredAt: NOW - index }),
    );
    const observedQueries: EventPageQuery[] = [];
    let queryCount = 0;
    const { container, emitMessage } = await renderPopup({
      query: async (query) => {
        observedQueries.push(query);
        queryCount += 1;
        if (queryCount === 1) return firstPage;
        if (queryCount === 2) throw new Error('live refresh failed');
        return [];
      },
    });
    await waitFor(() => expect(cardCount(container)).toBe(50));

    act(() => emitMessage({ protocolVersion: 1, type: 'events.changed' }));
    await waitFor(() => expect(queryCount).toBe(2));
    expect(cardCount(container)).toBe(50);
    expect(screen.getByRole('button', { name: /load more/i })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(queryCount).toBe(3));
    expect(observedQueries[2]).toMatchObject({
      beforeOccurredAt: firstPage[49]?.occurredAt,
      beforeId: firstPage[49]?.id,
    });
  });
});

describe('feed filters', () => {
  it('does not let a live signal invalidate a pending filter reload', async () => {
    const initial = makeEvent({ id: 'initial-filter', tokenSymbol: 'INITIALFULL' });
    const filtered = makeEvent({
      id: 'filtered-full',
      tokenSymbol: 'FULL',
      chain: 'solana',
      tokenAddress: 'So11111111111111111111111111111111111111112',
    });
    const latest = makeEvent({
      id: 'filtered-live',
      tokenSymbol: 'LATESTFULL',
      chain: 'solana',
      tokenAddress: 'So11111111111111111111111111111111111111112',
    });
    let queryCount = 0;
    let resolveFull: ((events: TradeEventV1[]) => void) | undefined;
    let resolveFollowUp: ((events: TradeEventV1[]) => void) | undefined;
    const { emitMessage } = await renderPopup({
      query: async () => {
        queryCount += 1;
        if (queryCount === 1) return [initial];
        if (queryCount === 2) return new Promise((resolve) => { resolveFull = resolve; });
        return new Promise((resolve) => { resolveFollowUp = resolve; });
      },
    });
    await screen.findByText('$INITIALFULL');
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Chain' }), {
      target: { value: 'solana' },
    });
    await waitFor(() => expect(resolveFull).toBeDefined());

    act(() => emitMessage({ protocolVersion: 1, type: 'events.changed' }));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    expect(queryCount).toBe(2);

    await act(async () => { resolveFull?.([filtered]); await Promise.resolve(); });
    expect(await screen.findByText('$FULL')).toBeInTheDocument();
    await waitFor(() => expect(resolveFollowUp).toBeDefined());
    await act(async () => { resolveFollowUp?.([latest]); await Promise.resolve(); });
    expect(await screen.findByText('$LATESTFULL')).toBeInTheDocument();
  });

  it('remains recoverable when a signalled pending filter reload fails', async () => {
    let queryCount = 0;
    let rejectFull: ((error: Error) => void) | undefined;
    const recovered = makeEvent({
      id: 'recovered-live',
      tokenSymbol: 'RECOVERED',
      chain: 'solana',
      tokenAddress: 'So11111111111111111111111111111111111111112',
    });
    const { emitMessage } = await renderPopup({
      query: async () => {
        queryCount += 1;
        if (queryCount === 1) return [makeEvent({ id: 'initial-before-failure', tokenSymbol: 'BEFOREFAIL' })];
        if (queryCount === 2) {
          return new Promise((_resolve, reject) => { rejectFull = reject; });
        }
        return [recovered];
      },
    });
    await screen.findByText('$BEFOREFAIL');
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Chain' }), {
      target: { value: 'solana' },
    });
    await waitFor(() => expect(rejectFull).toBeDefined());
    act(() => emitMessage({ protocolVersion: 1, type: 'events.changed' }));
    await act(async () => { rejectFull?.(new Error('filter failed')); await Promise.resolve(); });
    expect(await screen.findByText(/history could not be loaded/i)).toBeInTheDocument();
    expect(queryCount).toBe(2);

    act(() => emitMessage({ protocolVersion: 1, type: 'events.changed' }));
    expect(await screen.findByText('$RECOVERED')).toBeInTheDocument();
    expect(queryCount).toBe(3);
  });

  it('clears old-filter pagination after a failed filter reload and retry restores it', async () => {
    const oldPage = Array.from({ length: 50 }, (_, index) =>
      makeEvent({ id: `old-filter-${index}`, occurredAt: NOW - index }),
    );
    const freshPage = Array.from({ length: 50 }, (_, index) =>
      makeEvent({
        id: `fresh-filter-${index}`,
        chain: 'solana',
        tokenAddress: 'So11111111111111111111111111111111111111112',
        occurredAt: NOW + 100 - index,
      }),
    );
    const observedQueries: EventPageQuery[] = [];
    let queryCount = 0;
    await renderPopup({
      query: async (query) => {
        observedQueries.push(query);
        queryCount += 1;
        if (queryCount === 1) return oldPage;
        if (queryCount === 2) throw new Error('filter reload failed');
        if (queryCount === 3) return freshPage;
        return [];
      },
    });
    await screen.findByRole('button', { name: /load more/i });

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Chain' }), {
      target: { value: 'solana' },
    });
    expect(await screen.findByText(/history could not be loaded/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findAllByText('$FOMO')).toHaveLength(50);
    fireEvent.click(screen.getByRole('button', { name: /load more/i }));
    await waitFor(() => expect(queryCount).toBe(4));
    expect(observedQueries[3]).toMatchObject({
      chain: 'solana',
      beforeOccurredAt: freshPage[49]?.occurredAt,
      beforeId: freshPage[49]?.id,
    });
  });

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

    fireEvent.click(screen.getByRole('button', { name: 'Unread' }));

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

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Action' }), {
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

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Chain' }), {
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

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Trader' }), {
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

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Token' }), {
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

    fireEvent.click(screen.getByRole('button', { name: 'Pinned' }));

    await waitFor(() => {
      expect(cards()[0]?.getAttribute('data-event-id')).toBe('older-pinned');
    });
  });
});

describe('history card content and actions', () => {
  it('shows the complete event fields plus read state', async () => {
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
    // Metric grid has been removed (Task 5); the history card shows no metric labels.
    expect(within(card).queryByText('7d PnL')).not.toBeInTheDocument();
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
    const addressLabel = card.querySelector('.copyable-address-label');
    const addressValue = card.querySelector('.copyable-address-value');

    expect(addressLabel).toHaveTextContent('CA:');
    expect(addressValue?.textContent).toBe(TOKEN_ADDRESS);
    expect(addressValue).not.toHaveTextContent('CA:');

    await act(async () => {
      fireEvent.click(copyButton);
    });

    await waitFor(() => expect(copyText).toHaveBeenCalledWith(TOKEN_ADDRESS));
    expect(await within(card).findByRole('status')).toHaveTextContent('Copied');
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

    expect(link).toHaveAttribute('href', 'https://fomo.family/profile/alpha');
  });

  it('renders inline followers only when a valid value exists, never Unavailable', async () => {
    const event = makeEvent({
      metricSnapshot: { fetchedAt: NOW, source: 'fomo-profile', followers: 1234 },
    });
    const { container } = await renderPopup({ events: [event] });

    await waitFor(() => expect(cardCount(container)).toBe(1));

    expect(screen.getByText(/1\.23K followers/)).toBeInTheDocument();
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
  });

  it('omits followers for an invalid or missing value', async () => {
    const event = makeEvent({
      metricSnapshot: { fetchedAt: NOW, source: 'fomo-profile' },
    });
    const { container } = await renderPopup({ events: [event] });

    await waitFor(() => expect(cardCount(container)).toBe(1));

    expect(screen.queryByText(/followers/i)).not.toBeInTheDocument();
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
  it('ignores a successful markRead completion after unmount', async () => {
    let resolveMarkRead!: (value: boolean) => void;
    const markRead = () => new Promise<boolean>((resolve) => { resolveMarkRead = resolve; });
    const { container, unmount } = await renderPopup({
      events: [makeEvent({ id: 'fomo:event-0' })],
      markRead,
    });

    await waitFor(() => expect(cardCount(container)).toBe(1));
    await waitFor(() => expect(resolveMarkRead).toBeTypeOf('function'));
    unmount();
    resolveMarkRead(true);
    await Promise.resolve();

    expect(container.childElementCount).toBe(0);
  });

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

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const traderSelect = screen.getByRole('combobox', { name: 'Trader' });
    const options = Array.from(traderSelect.querySelectorAll('option')).map(
      (option) => option.textContent ?? '',
    );

    // The hidden 'beta' trader is no longer offered as a filter target.
    expect(options).toContain('@alpha');
    expect(options).not.toContain('@beta');
    expect(container.querySelector('.popup-feed')).not.toBeNull();
  });
});
