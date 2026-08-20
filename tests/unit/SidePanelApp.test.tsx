import 'fake-indexeddb/auto';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionQueryResponse } from '../../src/messaging/protocol';
import type { PipelineHealthSnapshotV1 } from '../../src/background/pipeline-health';
import {
  SidePanelApp,
  type SidePanelDependencies,
} from '../../src/sidepanel/SidePanelApp';

function createHarness(connection: ConnectionQueryResponse) {
  const listeners: Array<(message: unknown) => void> = [];
  let verdict = connection;
  let connectionQueries = 0;
  let connectionFailure = false;
  let healthQueries = 0;
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
          return { ok: true, events: [] };
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
    setHealth(next: PipelineHealthSnapshotV1) {
      health = next;
    },
    setVerdict(next: ConnectionQueryResponse) {
      verdict = next;
    },
    setConnectionFailure(fails: boolean) {
      connectionFailure = fails;
    },
    emit(message: unknown) {
      listeners.forEach((listener) => listener(message));
    },
  };
}

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
    expect(screen.getByRole('status')).toHaveTextContent('Connected');
    await act(async () => pending[0]?.({ ok: true, connected: false, authenticated: false, hasFomoTab: false }));
    expect(screen.getByRole('status')).toHaveTextContent('Connected');
  });

  it('keeps connection status visible and re-queries on live changes', async () => {
    const harness = createHarness({
      ok: true,
      connected: false,
      authenticated: false,
      hasFomoTab: false,
    });
    render(<SidePanelApp deps={harness.deps} />);
    expect(screen.getByRole('status')).toHaveTextContent('Checking…');
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Offline'));

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

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Connected'));
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

  it('uses an icon-only accessible settings toggle', async () => {
    const harness = createHarness({ ok: true, connected: true, authenticated: true, hasFomoTab: true });
    render(<SidePanelApp deps={harness.deps} />);
    const toggle = screen.getByRole('button', { name: 'Settings' });
    expect(toggle).not.toHaveTextContent('Settings');
    expect(toggle).toHaveAttribute('title', 'Settings');

    fireEvent.click(toggle);
    expect(await screen.findByRole('heading', { name: 'Metrics' })).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByRole('heading', { name: 'Metrics' })).not.toBeInTheDocument();
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

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Offline'));
    expect(screen.queryByText(/refresh the existing Fomo tab/i)).not.toBeInTheDocument();
  });
});
