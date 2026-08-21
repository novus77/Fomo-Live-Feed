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
import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import {
  SidePanelApp,
  type SidePanelDependencies,
} from '../../src/sidepanel/SidePanelApp';
import { OpinionTranslationCoordinator } from '../../src/translation/opinion-translation';

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

  const deps: SidePanelDependencies = {
    runtime: {
      async sendMessage(message: unknown): Promise<unknown> {
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
        async get() {
          return {};
        },
        async set() {},
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
    expect(harness.listenerCount()).toBe(4);

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
});
