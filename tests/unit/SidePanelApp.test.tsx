import 'fake-indexeddb/auto';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionQueryResponse } from '../../src/messaging/protocol';
import type { PipelineHealthSnapshotV1 } from '../../src/background/pipeline-health';
import type {
  ActivitySyncReason,
  ActivitySyncState,
} from '../../src/background/activity-sync';
import type { TradeEventV1 } from '../../src/domain/activity';
import { DEFAULT_SETTINGS } from '../../src/domain/settings';
import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import {
  SidePanelApp,
  type SidePanelDependencies,
} from '../../src/sidepanel/SidePanelApp';
import { BSC_SUPPORT_ADDRESS } from '../../src/sidepanel/SupportPanel';
import { OpinionTranslationCoordinator } from '../../src/translation/opinion-translation';
import { SETTINGS_STORAGE_KEY } from '../../src/storage/local-preferences';

// The side panel renders its strings through useLocale. The real
// LocaleProvider behavior is covered by LocaleProvider.test.tsx; here the
// hook is replaced with a stable EN catalog so component behavior stays
// synchronous. The shared spy lets tests assert the EN / 中文 switch wiring.
const { mockSetLocale } = vi.hoisted(() => ({ mockSetLocale: vi.fn() }));

vi.mock('../../src/i18n/LocaleProvider', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/i18n/LocaleProvider')>();
  const { translate: translateMessage } = await import('../../src/i18n/catalog');

  const useLocale = (): LocaleContextValue => ({
    locale: 'en',
    setLocale: mockSetLocale,
    translate: (key, values) => translateMessage('en', key, values),
  });

  return { ...actual, useLocale };
});

function createHarness(connection: ConnectionQueryResponse) {
  const listeners: Array<(message: unknown) => void> = [];
  let verdict = connection;
  let connectionQueries = 0;
  let connectionFailure = false;
  let healthQueries = 0;
  let eventQueries = 0;
  let syncQueries = 0;
  let syncFailure = false;
  // A fresh recovery state by default so the stale-panel-open one-shot never
  // fires unless a test explicitly makes the state stale.
  let syncState: ActivitySyncState = { status: 'current', finishedAt: 1_800_000_000_000 };
  const syncRequests: Array<{ reason: ActivitySyncReason }> = [];
  let health: PipelineHealthSnapshotV1 = {
    schemaVersion: 1,
    observerInstalled: true,
    socketObserved: false,
    socketOpen: false,
    activityCandidates: 0,
    accepted: 0,
    rejected: 0,
    duplicates: 0,
    persisted: 0,
    broadcasts: 0,
  };
  const opened: URL[] = [];
  const sentMessages: unknown[] = [];
  const storageRecords: Record<string, unknown> = {};
  let storageSetFailure = false;

  const deps: SidePanelDependencies = {
    runtime: {
      async sendMessage(message: unknown): Promise<unknown> {
        sentMessages.push(message);
        const type = (message as { type?: string }).type;
        if (type === 'connection.query') {
          connectionQueries += 1;
          if (connectionFailure) {
            throw new Error('connection query failed');
          }
          return verdict;
        }
        if (type === 'pipeline.healthQuery') {
          healthQueries += 1;
          return {
            ok: true,
            health,
          };
        }
        if (type === 'events.query') {
          eventQueries += 1;
          return { ok: true, events: [] };
        }
        if (type === 'sync.query') {
          syncQueries += 1;
          if (syncFailure) {
            throw new Error('sync query failed');
          }
          return { ok: true, state: syncState };
        }
        if (type === 'sync.request') {
          const reason = (message as { payload: { reason: ActivitySyncReason } })
            .payload.reason;
          syncRequests.push({ reason });
          // The worker moves to 'syncing' synchronously before its first
          // await; mirror that so the panel's follow-up query reflects it.
          syncState = {
            status: 'syncing',
            reason,
            startedAt: 1_800_000_000_000,
          };
          return { ok: true };
        }
        return { ok: true };
      },
      onMessage: {
        addListener(listener) { listeners.push(listener); },
        removeListener(listener) {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        },
      },
    },
    storage: {
      local: {
        async get(keys: string[]) {
          return Object.fromEntries(keys.filter((key) => key in storageRecords).map((key) => [key, storageRecords[key]]));
        },
        async set(items: Record<string, unknown>) {
          if (storageSetFailure) throw new Error('storage write failed');
          Object.assign(storageRecords, items);
        },
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    now: () => 1_800_000_000_000,
    openLink: (url) => {
      opened.push(url);
    },
    copyText: async () => {},
  };

  return {
    deps,
    opened,
    connectionQueries: () => connectionQueries,
    healthQueries: () => healthQueries,
    eventQueries: () => eventQueries,
    syncQueries: () => syncQueries,
    syncRequests: () => syncRequests,
    sentMessages: () => sentMessages,
    storageRecords,
    listenerCount: () => listeners.length,
    setHealth(next: PipelineHealthSnapshotV1) {
      health = next;
    },
    setVerdict(next: ConnectionQueryResponse) {
      verdict = next;
    },
    setConnectionFailure(fails: boolean) {
      connectionFailure = fails;
    },
    setSyncState(next: ActivitySyncState) {
      syncState = next;
    },
    setSyncFailure(fails: boolean) {
      syncFailure = fails;
    },
    setStorageSetFailure(fails: boolean) {
      storageSetFailure = fails;
    },
    emit(message: unknown) {
      listeners.forEach((listener) => listener(message));
    },
  };
}

/** The ConnectionIndicator live region (the panel renders a second role=status
 * for the refresh control, so status queries must be scoped). */
const connectionStatus = (): HTMLElement => {
  const element = document.querySelector('.connection-indicator');

  if (element === null) {
    throw new Error('missing connection indicator');
  }

  return element as HTMLElement;
};

afterEach(() => {
  vi.useRealTimers();
});

describe('SidePanelApp', () => {
  it('keeps the four utility controls in one compact header toolbar', async () => {
    const harness = createHarness({
      ok: true,
      connected: true,
      authenticated: true,
      hasFomoTab: true,
    });
    const { container } = render(<SidePanelApp deps={harness.deps} />);

    await waitFor(() => expect(connectionStatus()).toHaveTextContent('Connected'));
    const header = container.querySelector<HTMLElement>('[data-ui-region="header"]');
    const toolbar = container.querySelector<HTMLElement>('[data-ui-region="toolbar"]');

    expect(header).toContainElement(screen.getByRole('heading', { name: 'Fomo Live Feed' }));
    expect(header).toContainElement(connectionStatus());
    expect(header).toContainElement(toolbar);
    expect(within(toolbar as HTMLElement).getAllByRole('button')).toHaveLength(4);
    expect(toolbar?.querySelectorAll('.compact-icon-button')).toHaveLength(4);
  });

  it('restores muted chains, persists changes, and never exposes unknown', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    harness.storageRecords[SETTINGS_STORAGE_KEY] = {
      ...DEFAULT_SETTINGS,
      filters: { mutedChains: ['base', 'unknown'] },
    };
    render(<SidePanelApp deps={harness.deps} />);

    await waitFor(() => expect(connectionStatus()).toHaveTextContent('Connected'));
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.getByRole('button', { name: 'Base' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: 'Unknown' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Base' }));
    expect(screen.getByRole('button', { name: 'Base' })).toHaveAttribute('aria-pressed', 'true');
    await waitFor(() => expect(
      (harness.storageRecords[SETTINGS_STORAGE_KEY] as typeof DEFAULT_SETTINGS).filters.mutedChains,
    ).toEqual([]));
  });

  it('keeps an optimistic chain selection when persistence fails', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    harness.setStorageSetFailure(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<SidePanelApp deps={harness.deps} />);

    await waitFor(() => expect(connectionStatus()).toHaveTextContent('Connected'));
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Base' }));

    expect(screen.getByRole('button', { name: 'Base' })).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Base' })).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Solana' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Solana' }))
      .toHaveAttribute('aria-pressed', 'false'));
    expect(warn).toHaveBeenCalledTimes(1);

    harness.setStorageSetFailure(false);
    fireEvent.click(screen.getByRole('button', { name: 'Solana' }));
    await waitFor(() => expect(
      (harness.storageRecords[SETTINGS_STORAGE_KEY] as typeof DEFAULT_SETTINGS).filters.mutedChains,
    ).toEqual(['base']));

    harness.setStorageSetFailure(true);
    fireEvent.click(screen.getByRole('button', { name: 'Ethereum' }));
    await waitFor(() => expect(warn).toHaveBeenCalledTimes(2));
    warn.mockRestore();
  });

  it('serializes rapid chain changes and preserves notification settings', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    render(<SidePanelApp deps={harness.deps} />);

    await waitFor(() => expect(connectionStatus()).toHaveTextContent('Connected'));
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Base' }));
    fireEvent.click(screen.getByRole('button', { name: 'Solana' }));

    await waitFor(() => expect(
      (harness.storageRecords[SETTINGS_STORAGE_KEY] as typeof DEFAULT_SETTINGS).filters.mutedChains,
    ).toEqual(['solana', 'base']));
    expect(
      (harness.storageRecords[SETTINGS_STORAGE_KEY] as typeof DEFAULT_SETTINGS).notifications.soundEnabled,
    ).toBe(false);
  });

  it('shows the no-chain empty state and restores every chain', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    render(<SidePanelApp deps={harness.deps} />);

    await waitFor(() => expect(connectionStatus()).toHaveTextContent('Connected'));
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }));
    expect(await screen.findByText('No chains selected.')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Select all chains' }));
    await waitFor(() => expect(screen.queryByText('No chains selected.')).not.toBeInTheDocument());
    await waitFor(() => expect(
      (harness.storageRecords[SETTINGS_STORAGE_KEY] as typeof DEFAULT_SETTINGS).filters.mutedChains,
    ).toEqual([]));
  });

  it('orders filter, refresh, settings, and icon-only support in the header', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    const { container } = render(<SidePanelApp deps={harness.deps} />);

    await waitFor(() => expect(connectionStatus()).toHaveTextContent('Connected'));
    const header = container.querySelector('.sidepanel-header');
    expect(header).not.toBeNull();
    const buttons = within(header as HTMLElement).getAllByRole('button');
    expect(buttons).toHaveLength(4);
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Filters',
      'Refresh',
      'Settings',
      'Support',
    ]);
    expect(screen.getByRole('button', { name: 'Support' })).toHaveTextContent('');
  });

  it('keeps filters, Settings, and Support mutually exclusive', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    render(<SidePanelApp deps={harness.deps} />);

    await waitFor(() => expect(connectionStatus()).toHaveTextContent('Connected'));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByRole('region', { name: 'Settings' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    expect(screen.queryByRole('region', { name: 'Settings' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Feed filters' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Support' }));
    expect(screen.queryByRole('dialog', { name: 'Feed filters' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Settings' })).not.toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Support the Developer' }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Support' }));
    expect(
      screen.queryByRole('region', { name: 'Support the Developer' }),
    ).not.toBeInTheDocument();
  });

  it('reloads paginated history when Side Panel action or market-cap filters change', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    render(<SidePanelApp deps={harness.deps} />);
    await waitFor(() => expect(harness.eventQueries()).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'Buy' }));
    await waitFor(() => expect(harness.eventQueries()).toBe(2));

    fireEvent.change(screen.getByRole('textbox', { name: 'Minimum market cap in K' }), {
      target: { value: '200' },
    });
    await waitFor(() => expect(harness.eventQueries()).toBe(3));
  });

  it('uses the injected support copy and navigation boundaries', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    const copyText = vi.fn().mockResolvedValue(undefined);
    harness.deps.copyText = copyText;
    render(<SidePanelApp deps={harness.deps} />);

    await waitFor(() => expect(connectionStatus()).toHaveTextContent('Connected'));
    fireEvent.click(screen.getByRole('button', { name: 'Support' }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Copy Robinhood & BSC address' }),
    );
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(BSC_SUPPORT_ADDRESS));
    fireEvent.click(screen.getByRole('link', { name: '@XXten177' }));
    expect(harness.opened.at(-1)?.href).toBe('https://t.me/XXten177');
  });

  it('sends only chain and token address when token identity is clicked', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    const original = harness.deps.runtime.sendMessage.bind(harness.deps.runtime);
    harness.deps.runtime.sendMessage = async (message: unknown) => {
      if ((message as { type?: string }).type === 'events.query') {
        return {
          ok: true,
          events: [{
            schemaVersion: 1,
            id: 'event-navigation',
            source: 'fomo',
            traderId: 'trader-1',
            traderHandle: 'alpha',
            chain: 'bsc',
            tokenAddress: '0x020bfc650a365f8bb26819deaabf3e21291018b4',
            tokenSymbol: 'FOMO',
            action: 'buy',
            occurredAt: 1_800_000_000_000,
            receivedAt: 1_800_000_000_000,
          }],
        };
      }
      return original(message);
    };
    render(<SidePanelApp deps={harness.deps} />);
    fireEvent.click(await screen.findByRole('button', { name: '$FOMO' }));
    expect(harness.sentMessages()).toContainEqual({
      protocolVersion: 1,
      type: 'navigation.openToken',
      payload: {
        chain: 'bsc',
        tokenAddress: '0x020bfc650a365f8bb26819deaabf3e21291018b4',
      },
    });
  });

  it('applies theme changes from Settings', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    const { container } = render(<SidePanelApp deps={harness.deps} />);

    await waitFor(() => expect(connectionStatus()).toHaveTextContent('Connected'));
    expect(container.querySelector('.sidepanel-root')).toHaveAttribute('data-theme', 'dark');

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('button', { name: 'Light theme' }));

    await waitFor(() =>
      expect(container.querySelector('.sidepanel-root')).toHaveAttribute('data-theme', 'light'),
    );
  });

  it('persists buy sound immediately and notifies the worker', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    render(<SidePanelApp deps={harness.deps} />);

    await waitFor(() => expect(connectionStatus()).toHaveTextContent('Connected'));
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const toggle = screen.getByRole('checkbox', { name: 'Buy sound alert' });
    expect(toggle).not.toBeChecked();

    fireEvent.click(toggle);

    await waitFor(() => expect(
      (harness.storageRecords[SETTINGS_STORAGE_KEY] as { notifications?: { soundEnabled?: boolean } })
        ?.notifications?.soundEnabled,
    ).toBe(true));
    expect(harness.sentMessages()).toContainEqual({
      protocolVersion: 1,
      type: 'preferences.changed',
    });
  });

  it('keeps the latest connection result when concurrent queries finish out of order', async () => {
    const harness = createHarness({ ok: true, connected: false, authenticated: false, hasFomoTab: false });
    const pending: Array<(value: ConnectionQueryResponse) => void> = [];
    const originalSendMessage = harness.deps.runtime.sendMessage.bind(harness.deps.runtime);
    harness.deps.runtime.sendMessage = async (message: unknown) => {
      if ((message as { type?: string }).type === 'connection.query') {
        return new Promise<ConnectionQueryResponse>((resolve) => pending.push(resolve));
      }
      return originalSendMessage(message);
    };

    render(<SidePanelApp deps={harness.deps} />);
    await waitFor(() => expect(pending).toHaveLength(1));
    act(() => harness.emit({
      protocolVersion: 1,
      type: 'connection.changed',
      payload: { connected: true, authenticated: true, at: 1 },
    }));
    await waitFor(() => expect(pending).toHaveLength(2));

    await act(async () => pending[1]?.({ ok: true, connected: true, authenticated: true, hasFomoTab: true }));
    expect(connectionStatus()).toHaveTextContent('Connected');
    await act(async () => pending[0]?.({ ok: true, connected: false, authenticated: false, hasFomoTab: false }));
    expect(connectionStatus()).toHaveTextContent('Connected');
  });

  it('keeps connection status visible and re-queries on live changes', async () => {
    const harness = createHarness({
      ok: true,
      connected: false,
      authenticated: false,
      hasFomoTab: false,
    });
    render(<SidePanelApp deps={harness.deps} />);
    expect(connectionStatus()).toHaveTextContent('Checking…');
    await waitFor(() => expect(connectionStatus()).toHaveTextContent('Offline'));

    harness.setVerdict({
      ok: true,
      connected: true,
      authenticated: true,
      hasFomoTab: true,
    });
    act(() => harness.emit({
      protocolVersion: 1,
      type: 'connection.changed',
      payload: { connected: true, authenticated: true, at: 1 },
    }));

    await waitFor(() => expect(connectionStatus()).toHaveTextContent('Connected'));
  });

  it('bounds stale state with a 30 second re-query', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    render(<SidePanelApp deps={harness.deps} />);
    await act(async () => { await Promise.resolve(); });
    expect(harness.connectionQueries()).toBe(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(harness.connectionQueries()).toBe(2);
    expect(harness.healthQueries()).toBe(2);
  });

  it('removes health listeners and stops the diagnostics refresh timer on unmount', async () => {
    vi.useFakeTimers();
    const harness = createHarness({
      ok: true,
      connected: true,
      authenticated: true,
      hasFomoTab: true,
    });
    const { unmount } = render(<SidePanelApp deps={harness.deps} />);

    await act(async () => { await Promise.resolve(); });
    expect(harness.healthQueries()).toBe(1);
    // Connection, health, feed changes, sync changes, and translation-ready.
    expect(harness.listenerCount()).toBe(5);

    unmount();
    expect(harness.listenerCount()).toBe(0);
    const queriesAtUnmount = harness.healthQueries();

    act(() => harness.emit({
      protocolVersion: 1,
      type: 'pipeline.healthChanged',
    }));
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

    expect(harness.healthQueries()).toBe(queriesAtUnmount);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses an icon-only accessible settings toggle', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    render(<SidePanelApp deps={harness.deps} />);
    const toggle = screen.getByRole('button', { name: 'Settings' });
    expect(toggle).not.toHaveTextContent('Settings');
    expect(toggle).toHaveAttribute('title', 'Settings');

    fireEvent.click(toggle);
    expect(await screen.findByRole('heading', { name: 'Language' })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByRole('heading', { name: 'Language' })).not.toBeInTheDocument();
  });

  it('renders queried diagnostics in settings and refreshes them on health changes', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    render(<SidePanelApp deps={harness.deps} />);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    expect(await screen.findByRole('heading', { name: 'Pipeline diagnostics' })).toBeInTheDocument();
    expect(screen.getByText('Observer ready')).toBeInTheDocument();

    harness.setHealth({
      schemaVersion: 1,
      observerInstalled: true,
      socketObserved: true,
      socketOpen: true,
      activityCandidates: 5,
      accepted: 5,
      rejected: 0,
      duplicates: 0,
      persisted: 5,
      broadcasts: 5,
    });
    act(() => harness.emit({
      protocolVersion: 1,
      type: 'pipeline.healthChanged',
    }));

    await waitFor(() => expect(screen.getByText('Socket observed / open')).toBeInTheDocument());
    expect(harness.healthQueries()).toBeGreaterThanOrEqual(2);
  });

  it('coalesces health-change bursts without re-querying connection and converges', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    render(<SidePanelApp deps={harness.deps} />);
    await act(async () => { await Promise.resolve(); });
    expect(harness.connectionQueries()).toBe(1);
    expect(harness.healthQueries()).toBe(1);

    harness.setHealth({
      schemaVersion: 1,
      observerInstalled: true,
      socketObserved: true,
      socketOpen: true,
      activityCandidates: 5,
      accepted: 5,
      rejected: 0,
      duplicates: 0,
      persisted: 5,
      broadcasts: 5,
    });
    act(() => {
      for (let index = 0; index < 20; index += 1) {
        harness.emit({ protocolVersion: 1, type: 'pipeline.healthChanged' });
      }
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });

    expect(harness.connectionQueries()).toBe(1);
    expect(harness.healthQueries()).toBe(2);
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByText('Socket observed / open')).toBeInTheDocument();
  });

  it('coalesces event-change bursts into a bounded refresh and cleans up on unmount', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    const { unmount } = render(<SidePanelApp deps={harness.deps} />);
    await act(async () => { await Promise.resolve(); });
    expect(harness.eventQueries()).toBe(1);

    act(() => {
      for (let index = 0; index < 20; index += 1) {
        harness.emit({ protocolVersion: 1, type: 'events.changed' });
      }
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(harness.eventQueries()).toBe(2);

    unmount();
    const queriesAtUnmount = harness.eventQueries();
    act(() => harness.emit({ protocolVersion: 1, type: 'events.changed' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(harness.eventQueries()).toBe(queriesAtUnmount);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refreshes within a bounded latency while event changes continue', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    render(<SidePanelApp deps={harness.deps} />);
    await act(async () => { await Promise.resolve(); });
    expect(harness.eventQueries()).toBe(1);

    for (let elapsed = 0; elapsed < 400; elapsed += 40) {
      act(() => harness.emit({ protocolVersion: 1, type: 'events.changed' }));
      await act(async () => { await vi.advanceTimersByTimeAsync(40); });
    }

    expect(harness.eventQueries()).toBeGreaterThanOrEqual(2);
  });

  it('advances relative labels only while diagnostics are visible', async () => {
    vi.useFakeTimers();
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    harness.setHealth({
      schemaVersion: 1,
      observerInstalled: true,
      socketObserved: true,
      socketOpen: true,
      lastFrameAt: 1_800_000_000_000,
      activityCandidates: 0,
      accepted: 0,
      rejected: 0,
      duplicates: 0,
      persisted: 0,
      broadcasts: 0,
    });
    let currentTime = 1_800_000_000_000;
    harness.deps.now = () => currentTime;
    const { unmount } = render(<SidePanelApp deps={harness.deps} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    expect(screen.getByText('0s ago')).toBeInTheDocument();

    currentTime += 5_000;
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByText('5s ago')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));
    const timersAfterClose = vi.getTimerCount();
    expect(timersAfterClose).toBe(2);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('offers manual refresh guidance without reloading tabs', async () => {
    const harness = createHarness({ ok: true, connected: false, authenticated: false, hasFomoTab: true });
    render(<SidePanelApp deps={harness.deps} />);

    expect(await screen.findByText(/refresh the existing Fomo tab/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Open Fomo' }));
    expect(harness.opened[0]?.href).toBe('https://fomo.family/');
  });

  it('clears refresh guidance when the next connection query fails', async () => {
    const harness = createHarness({ ok: true, connected: false, authenticated: false, hasFomoTab: true });
    render(<SidePanelApp deps={harness.deps} />);
    expect(await screen.findByText(/refresh the existing Fomo tab/i)).toBeInTheDocument();

    harness.setConnectionFailure(true);
    act(() => harness.emit({
      protocolVersion: 1,
      type: 'connection.changed',
      payload: { connected: false, authenticated: false, at: 2 },
    }));

    await waitFor(() => expect(connectionStatus()).toHaveTextContent('Offline'));
    expect(screen.queryByText(/refresh the existing Fomo tab/i)).not.toBeInTheDocument();
  });

  it('does not render the locale switcher in the main view; it lives only in settings', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    render(<SidePanelApp deps={harness.deps} />);
    // Flush the mount microtasks (connection/health/sync queries) so their
    // state updates stay inside act().
    await act(async () => { await Promise.resolve(); });

    expect(screen.queryByRole('group', { name: /switch ui language/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Settings' }));

    const group = await screen.findByRole('group', { name: /switch ui language/i });
    const en = within(group).getByRole('button', { name: 'EN' });
    const zh = within(group).getByRole('button', { name: '中文' });

    expect(en).toHaveAttribute('aria-pressed', 'true');
    expect(zh).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(zh);
    expect(mockSetLocale).toHaveBeenCalledWith('zh-CN');

    fireEvent.click(en);
    expect(mockSetLocale).toHaveBeenCalledWith('en');
  });

  it('queries recovery state on mount and re-queries on sync.changed', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    render(<SidePanelApp deps={harness.deps} />);
    await waitFor(() => expect(harness.syncQueries()).toBe(1));

    harness.setSyncState({ status: 'updated', added: 3, finishedAt: 1_800_000_000_000 });
    act(() => harness.emit({ protocolVersion: 1, type: 'sync.changed' }));
    await waitFor(() => expect(harness.syncQueries()).toBe(2));
    expect(screen.getByText('Updated')).toBeInTheDocument();
  });

  it('sends sync.request with reason manual on the refresh click and reflects syncing', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    render(<SidePanelApp deps={harness.deps} />);
    await waitFor(() => expect(harness.syncQueries()).toBe(1));

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(harness.syncRequests()).toContainEqual({ reason: 'manual' }));
    expect(screen.getByText('Refreshing…')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
  });

  it('triggers exactly one stale-panel-open sync when connected with a stale feed', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    harness.setSyncState({
      status: 'idle',
      lastSucceededAt: 1_800_000_000_000 - 6 * 60 * 1_000,
    });
    render(<SidePanelApp deps={harness.deps} />);

    await waitFor(() => expect(harness.syncRequests()).toContainEqual({ reason: 'stale-panel-open' }));
    expect(harness.syncRequests().filter((request) => request.reason === 'stale-panel-open')).toHaveLength(1);

    // Later sync.changed re-queries must not re-trigger the one-shot.
    act(() => harness.emit({ protocolVersion: 1, type: 'sync.changed' }));
    await act(async () => { await Promise.resolve(); });
    expect(harness.syncRequests().filter((request) => request.reason === 'stale-panel-open')).toHaveLength(1);
  });

  it('does not trigger stale-panel-open when the last success is fresh', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    harness.setSyncState({ status: 'current', finishedAt: 1_800_000_000_000 - 60_000 });
    render(<SidePanelApp deps={harness.deps} />);
    await act(async () => { await Promise.resolve(); });
    expect(harness.syncRequests().filter((request) => request.reason === 'stale-panel-open')).toHaveLength(0);
  });

  it('requests a reconnect sync when connection.changed reports connected + authenticated', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    render(<SidePanelApp deps={harness.deps} />);
    await waitFor(() => expect(harness.syncQueries()).toBe(1));

    act(() => harness.emit({
      protocolVersion: 1,
      type: 'connection.changed',
      payload: { connected: true, authenticated: true, at: 1 },
    }));
    await waitFor(() => expect(harness.syncRequests()).toContainEqual({ reason: 'reconnect' }));
  });

  it('shares one translation coordinator across thesis cards and destroys it only on panel unmount', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    const originalSendMessage = harness.deps.runtime.sendMessage.bind(harness.deps.runtime);
    const makeThesisEvent = (id: string, thesis: string): TradeEventV1 => ({
      schemaVersion: 1,
      id,
      source: 'fomo',
      traderId: 'trader-' + id,
      traderHandle: 'alpha',
      chain: 'bsc',
      tokenAddress: '0x020bfc650a365f8bb26819deaabf3e21291018b4',
      tokenSymbol: 'FOMO',
      action: 'buy',
      usdAmount: 100,
      occurredAt: 1_800_000_000_000,
      receivedAt: 1_800_000_000_000,
      thesis,
    });
    harness.deps.runtime.sendMessage = async (message: unknown) => {
      if ((message as { type?: string }).type === 'events.query') {
        return {
          ok: true,
          events: [
            makeThesisEvent('thesis-1', 'Rotation into L1s'),
            makeThesisEvent('thesis-2', 'Chasing hot wallets'),
          ],
        };
      }
      return originalSendMessage(message);
    };

    const destroySpy = vi.spyOn(OpinionTranslationCoordinator.prototype, 'destroy');
    try {
      const { unmount } = render(<SidePanelApp deps={harness.deps} />);

      await waitFor(() =>
        expect(screen.getAllByText('Rotation into L1s').length).toBeGreaterThan(0),
      );
      await waitFor(() =>
        expect(screen.getAllByText('Chasing hot wallets').length).toBeGreaterThan(0),
      );

      // Cards share the ONE panel coordinator: none of them destroys it
      // while the panel stays mounted.
      expect(destroySpy).not.toHaveBeenCalled();

      unmount();

      // The panel root destroys its single shared coordinator exactly once.
      expect(destroySpy).toHaveBeenCalledTimes(1);
    } finally {
      destroySpy.mockRestore();
    }
  });

  it('retries opinion translation when the Fomo translation host reconnects', async () => {
    const languageSpy = vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('zh-CN');
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    const originalSendMessage = harness.deps.runtime.sendMessage.bind(harness.deps.runtime);
    let createCount = 0;
    const translatedSessionIds: string[] = [];
    harness.deps.runtime.sendMessage = async (message: unknown) => {
      const typed = message as { type?: string; payload?: { command?: string; sessionId?: string } };
      if (typed.type === 'events.query') {
        return {
          ok: true,
          events: [{
            schemaVersion: 1,
            id: 'translation-host-reconnect',
            source: 'fomo',
            traderId: 'trader-translation-host-reconnect',
            traderHandle: 'alpha',
            chain: 'bsc',
            tokenAddress: '0x020bfc650a365f8bb26819deaabf3e21291018b4',
            tokenSymbol: 'FOMO',
            action: 'buy',
            occurredAt: 1_800_000_000_000,
            receivedAt: 1_800_000_000_000,
            thesis: 'Translation host reconnect regression',
          } satisfies TradeEventV1],
        };
      }
      if (typed.type === 'translation.request') {
        switch (typed.payload?.command) {
          case 'detect':
            return { ok: true, result: { language: 'en', confidence: 1 } };
          case 'availability':
            return { ok: true, result: 'available' };
          case 'create':
            createCount += 1;
            return { ok: true, result: { sessionId: `session-${createCount}` } };
          case 'translate':
            translatedSessionIds.push(typed.payload.sessionId ?? 'missing');
            return { ok: true, result: `中文观点 ${typed.payload.sessionId ?? 'missing'}` };
          case 'destroy':
            return { ok: true, result: null };
        }
      }
      return originalSendMessage(message);
    };

    try {
      render(<SidePanelApp deps={harness.deps} />);
      expect(await screen.findByText('中文观点 session-1')).toBeInTheDocument();

      act(() => harness.emit({ protocolVersion: 1, type: 'translation.hostReady' }));

      expect(await screen.findByText('中文观点 session-2')).toBeInTheDocument();
      expect(createCount).toBe(2);
      expect(translatedSessionIds).toEqual(['session-1', 'session-2']);
    } finally {
      languageSpy.mockRestore();
    }
  });
});
