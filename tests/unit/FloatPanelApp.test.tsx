import 'fake-indexeddb/auto';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ConnectionQueryResponse } from '../../src/messaging/protocol';
import type { PipelineHealthSnapshotV1 } from '../../src/background/pipeline-health';
import type { ActivitySyncState } from '../../src/background/activity-sync';
import type { TradeEventV1 } from '../../src/domain/activity';
import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import {
  SidePanelApp,
  type SidePanelDependencies,
} from '../../src/sidepanel/SidePanelApp';
import {
  FloatingSurfaceHost,
  type MountPipFeed,
} from '../../src/floatpanel/FloatingSurfaceHost';
import {
  mountPipFeedRoot,
  type PipFeedRootOptions,
} from '../../src/floatpanel/PipFeedRoot';
import type { DocumentPictureInPictureLike } from '../../src/floatpanel/document-pip';
import {
  PIP_GEOMETRY_STORAGE_KEY,
} from '../../src/floatpanel/pip-geometry';
import { DEFAULT_SETTINGS } from '../../src/domain/settings';
import { SETTINGS_STORAGE_KEY } from '../../src/storage/local-preferences';

// Same locale stub as SidePanelApp.test.tsx: synchronous EN catalog so the
// render path does not depend on the real LocaleProvider's async locale load.
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

const CONNECTED: ConnectionQueryResponse = {
  ok: true,
  connected: true,
  authenticated: true,
  hasFomoTab: true,
};

const HEALTH: PipelineHealthSnapshotV1 = {
  schemaVersion: 1,
  observerInstalled: true,
  socketObserved: true,
  socketOpen: true,
  activityCandidates: 0,
  accepted: 0,
  rejected: 0,
  duplicates: 0,
  persisted: 0,
  broadcasts: 0,
};

const SYNC_CURRENT: ActivitySyncState = {
  status: 'current',
  finishedAt: 1_800_000_000_000,
};

function createHarness(surface: 'sidepanel' | 'floatpanel' | 'pip') {
  const listeners: Array<(message: unknown) => void> = [];
  const sentMessages: unknown[] = [];
  const storageRecords: Record<string, unknown> = {};
  const responseOverrides = new Map<string, unknown>();

  const deps: SidePanelDependencies = {
    runtime: {
      async sendMessage(message: unknown): Promise<unknown> {
        sentMessages.push(message);
        const type = (message as { type?: string }).type;
        if (type !== undefined && responseOverrides.has(type)) {
          const response = responseOverrides.get(type);
          return typeof response === 'function'
            ? (response as (message: unknown) => unknown)(message)
            : response;
        }
        if (type === 'connection.query') {
          return CONNECTED;
        }
        if (type === 'pipeline.healthQuery') {
          return { ok: true, health: HEALTH };
        }
        if (type === 'events.query') {
          return { ok: true, events: [] };
        }
        if (type === 'sync.query') {
          return { ok: true, state: SYNC_CURRENT };
        }
        if (type === 'pip.opened') {
          return { ok: true, created: true, ownerWindowId: 77 };
        }
        if (type === 'pip.ready') {
          return { ok: true, minimized: false };
        }
        return { ok: true };
      },
      onMessage: {
        addListener(listener) {
          listeners.push(listener);
        },
        removeListener(listener) {
          const index = listeners.indexOf(listener);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        },
      },
    },
    storage: {
      local: {
        async get(keys: string[]) {
          return Object.fromEntries(
            keys
              .filter((key) => key in storageRecords)
              .map((key) => [key, storageRecords[key]]),
          );
        },
        async set(items: Record<string, unknown>) {
          Object.assign(storageRecords, items);
        },
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    now: () => 1_800_000_000_000,
    openLink: () => {},
    copyText: async () => {},
    surface,
  };

  return {
    deps,
    readStored: (key: string) => storageRecords[key],
    seedStored: (key: string, value: unknown) => {
      storageRecords[key] = value;
    },
    geometryMessages: () =>
      sentMessages.filter(
        (message) => (message as { type?: string }).type === 'float.geometryChanged',
      ),
    sentMessages: () => sentMessages,
    setResponse: (type: string, response: unknown) => {
      responseOverrides.set(type, response);
    },
  };
}

interface PipWindowHarness {
  pipWindow: Window;
  pipDocument: Document;
  dispatchPageHide(): void;
}

function createPipWindow(): PipWindowHarness {
  const pipDocument = document.implementation.createHTMLDocument();
  const events = new EventTarget();
  let closed = false;
  const pipWindow = {
    document: pipDocument,
    get closed() {
      return closed;
    },
    close: vi.fn(() => {
      closed = true;
      events.dispatchEvent(new Event('pagehide'));
    }),
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
    dispatchEvent: events.dispatchEvent.bind(events),
  } as unknown as Window;

  return {
    pipWindow,
    pipDocument,
    dispatchPageHide: () => {
      closed = true;
      events.dispatchEvent(new Event('pagehide'));
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function hydratedActivationButton(): Promise<HTMLButtonElement> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  const button = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Keep floating window on top',
  });
  expect(button).toBeEnabled();
  return button;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SidePanelApp float surface', () => {
  it('reports the window geometry when mounted as the float panel', async () => {
    vi.useFakeTimers();
    const harness = createHarness('floatpanel');

    await act(async () => {
      render(<SidePanelApp deps={harness.deps} />);
      await Promise.resolve();
    });

    // The reporter is throttled (400ms); advance past the debounce window.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    expect(harness.geometryMessages().length).toBeGreaterThan(0);
    const payload = harness.geometryMessages()[0] as {
      payload: { width: number; height: number };
    };
    expect(payload.payload.width).toBeGreaterThan(0);
    expect(payload.payload.height).toBeGreaterThan(0);
  });

  it('never reports geometry on the default side-panel surface', async () => {
    vi.useFakeTimers();
    const harness = createHarness('sidepanel');

    await act(async () => {
      render(<SidePanelApp deps={harness.deps} />);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(harness.geometryMessages()).toHaveLength(0);
  });

  it('reports feed readiness once per mount after the initial snapshot is installed', async () => {
    const harness = createHarness('pip');
    const onFeedReady = vi.fn();

    const { rerender } = render(
      <SidePanelApp deps={harness.deps} onFeedReady={onFeedReady} />,
    );

    await waitFor(() => expect(onFeedReady).toHaveBeenCalledWith(0));
    rerender(<SidePanelApp deps={harness.deps} onFeedReady={onFeedReady} />);
    await Promise.resolve();

    expect(onFeedReady).toHaveBeenCalledTimes(1);
    expect(harness.geometryMessages()).toHaveLength(0);
  });
});

describe('FloatingSurfaceHost', () => {
  it('keeps activation locked until persisted PiP geometry is hydrated', async () => {
    const harness = createHarness('floatpanel');
    const geometryRead = deferred<Record<string, unknown>>();
    const originalGet = harness.deps.storage.local.get.bind(harness.deps.storage.local);
    harness.deps.storage.local.get = vi.fn((keys: string[]) => (
      keys.includes(PIP_GEOMETRY_STORAGE_KEY)
        ? geometryRead.promise
        : originalGet(keys)
    ));
    const requestWindow = vi.fn(() => new Promise<Window>(() => {}));

    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow }}
      />,
    );

    const activate = screen.getByRole('button', {
      name: 'Keep floating window on top',
    });
    expect(activate).toBeDisabled();
    fireEvent.click(activate);
    expect(requestWindow).not.toHaveBeenCalled();

    await act(async () => {
      geometryRead.resolve({
        [PIP_GEOMETRY_STORAGE_KEY]: { width: 524, height: 718 },
      });
      await geometryRead.promise;
    });
    await waitFor(() => expect(activate).toBeEnabled());
    fireEvent.click(activate);

    expect(requestWindow).toHaveBeenCalledWith({
      width: 524,
      height: 718,
      disallowReturnToOpener: false,
    });
  });

  it('unlocks activation with the default geometry after hydration fails', async () => {
    const harness = createHarness('floatpanel');
    const geometryRead = deferred<Record<string, unknown>>();
    const originalGet = harness.deps.storage.local.get.bind(harness.deps.storage.local);
    harness.deps.storage.local.get = vi.fn((keys: string[]) => (
      keys.includes(PIP_GEOMETRY_STORAGE_KEY)
        ? geometryRead.promise
        : originalGet(keys)
    ));
    const requestWindow = vi.fn(() => new Promise<Window>(() => {}));

    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow }}
      />,
    );
    const activate = screen.getByRole('button', {
      name: 'Keep floating window on top',
    });
    expect(activate).toBeDisabled();

    await act(async () => {
      geometryRead.reject(new Error('storage unavailable'));
      await geometryRead.promise.catch(() => {});
    });
    await waitFor(() => expect(activate).toBeEnabled());
    fireEvent.click(activate);

    expect(requestWindow).toHaveBeenCalledWith({
      width: 380,
      height: 600,
      disallowReturnToOpener: false,
    });
  });

  it('uses the persisted PiP content size without delaying the activation click', async () => {
    const harness = createHarness('floatpanel');
    harness.seedStored(PIP_GEOMETRY_STORAGE_KEY, { width: 524, height: 718 });
    const requestWindow = vi.fn(() => new Promise<Window>(() => {}));

    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow }}
      />,
    );

    await waitFor(() => expect(screen.getByText('Connected')).toBeVisible());
    fireEvent.click(await hydratedActivationButton());

    expect(requestWindow).toHaveBeenCalledWith({
      width: 524,
      height: 718,
      disallowReturnToOpener: false,
    });
  });

  it('persists resized PiP content geometry for the next activation', async () => {
    const harness = createHarness('floatpanel');
    const first = createPipWindow();
    Object.defineProperties(first.pipWindow, {
      innerWidth: { configurable: true, value: 612 },
      innerHeight: { configurable: true, value: 744 },
    });
    const requestWindow = vi.fn()
      .mockResolvedValueOnce(first.pipWindow)
      .mockImplementationOnce(() => new Promise<Window>(() => {}));
    let feedReady: ((eventWatermark: number) => void) | undefined;
    const mountPipFeed: MountPipFeed = (options) => {
      feedReady = options.onFeedReady;
      return vi.fn();
    };

    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow }}
        mountPipFeed={mountPipFeed}
      />,
    );
    fireEvent.click(await hydratedActivationButton());
    await waitFor(() => expect(feedReady).toBeDefined());
    await act(async () => {
      feedReady?.(0);
      await Promise.resolve();
    });
    await screen.findByText('Always-on-top window is active');
    first.pipWindow.dispatchEvent(new Event('resize'));

    await waitFor(() => {
      expect(harness.readStored(PIP_GEOMETRY_STORAGE_KEY)).toEqual({
        width: 612,
        height: 744,
      });
    });

    await act(async () => {
      first.dispatchPageHide();
      await Promise.resolve();
    });
    const reopen = await screen.findByRole('button', {
      name: 'Reopen always-on-top window',
    });
    act(() => fireEvent.click(reopen));
    expect(requestWindow).toHaveBeenLastCalledWith({
      width: 612,
      height: 744,
      disallowReturnToOpener: false,
    });
  });

  it('flushes the last clamped resize when native close beats the debounce', async () => {
    vi.useFakeTimers();
    const harness = createHarness('floatpanel');
    const pip = createPipWindow();
    Object.defineProperties(pip.pipWindow, {
      innerWidth: { configurable: true, writable: true, value: 120 },
      innerHeight: { configurable: true, writable: true, value: 4_000 },
    });
    let feedReady: ((eventWatermark: number) => void) | undefined;
    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{
          window: null,
          requestWindow: () => Promise.resolve(pip.pipWindow),
        }}
        mountPipFeed={(options) => {
          feedReady = options.onFeedReady;
          return vi.fn();
        }}
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(await hydratedActivationButton());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => feedReady?.(0));
    pip.pipWindow.dispatchEvent(new Event('resize'));

    act(() => pip.dispatchPageHide());
    await act(async () => { await Promise.resolve(); });
    expect(harness.readStored(PIP_GEOMETRY_STORAGE_KEY)).toEqual({
      width: 320,
      height: 1_200,
    });

    Object.defineProperties(pip.pipWindow, {
      innerWidth: { configurable: true, writable: true, value: 900 },
      innerHeight: { configurable: true, writable: true, value: 900 },
    });
    pip.pipWindow.dispatchEvent(new Event('resize'));
    await act(async () => { await vi.advanceTimersByTimeAsync(500); });
    expect(harness.readStored(PIP_GEOMETRY_STORAGE_KEY)).toEqual({
      width: 320,
      height: 1_200,
    });
  });

  it('applies the feed light theme to host lifecycle controls', async () => {
    const harness = createHarness('floatpanel');
    harness.seedStored(SETTINGS_STORAGE_KEY, {
      ...DEFAULT_SETTINGS,
      uiTheme: 'light',
    });

    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow: vi.fn(() => new Promise<Window>(() => {})) }}
      />,
    );

    await waitFor(() => {
      expect(document.querySelector('.floating-surface-host'))
        .toHaveAttribute('data-theme', 'light');
    });
  });

  it('keeps the existing feed visible in activation and offers the primary PiP action', async () => {
    const harness = createHarness('floatpanel');
    const requestWindow = vi.fn(() => new Promise<Window>(() => {}));

    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow }}
      />,
    );

    expect(document.querySelector('.sidepanel-root')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Keep floating window on top' }))
      .toBeDisabled();
    await hydratedActivationButton();
    await screen.findByText('Connected');
  });

  it('shows an honest Chrome 141 requirement and side-panel return without popup fallback', async () => {
    const harness = createHarness('floatpanel');

    render(<FloatingSurfaceHost deps={harness.deps} documentPip={null} />);

    expect(screen.getByText(/Chrome 141\+/)).toBeVisible();
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Return to Side Panel' }),
    ).toBeEnabled());
    expect(screen.queryByRole('button', { name: 'Keep floating window on top' }))
      .toBeNull();
    expect(document.querySelector('.sidepanel-root')).toBeNull();
  });

  it('acknowledges a pending floating switch before unsupported return can reverse it', async () => {
    const harness = createHarness('floatpanel');
    harness.deps.getCurrentWindowId = async () => 141;
    harness.setResponse('surface.bootstrap', {
      ok: true,
      transaction: {
        switchId: 'unsupported-ready',
        source: 'sidepanel',
        target: 'floating',
        sourceWindowId: 17,
        phase: 'awaiting-ready',
        startedAt: 1_800_000_000_000,
        sourceIdentity: { hostWindowId: 17, instanceToken: 'source-panel' },
        targetIdentity: { hostWindowId: 141, instanceToken: 'target-float' },
      },
    });
    harness.setResponse('surface.ready', { ok: true, switchId: 'unsupported-ready' });

    render(<FloatingSurfaceHost deps={harness.deps} documentPip={null} />);

    await waitFor(() => expect(harness.sentMessages()).toContainEqual({
      protocolVersion: 1,
      type: 'surface.ready',
      payload: {
        switchId: 'unsupported-ready',
        surface: 'floating',
        eventWatermark: 0,
        windowId: 141,
        instanceToken: expect.any(String),
      },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Return to Side Panel' }));
    await waitFor(() => expect(harness.sentMessages()).toContainEqual(
      expect.objectContaining({
        type: 'surface.switch.request',
        payload: expect.objectContaining({
          source: 'floating',
          target: 'sidepanel',
          sourceWindowId: 141,
        }),
      }),
    ));
  });

  it('keeps unsupported return locked through malformed bootstrap and ready responses', async () => {
    vi.useFakeTimers();
    const harness = createHarness('floatpanel');
    harness.deps.getCurrentWindowId = async () => 142;
    const transaction = {
      switchId: 'strict-ready',
      source: 'sidepanel',
      target: 'floating',
      sourceWindowId: 18,
      phase: 'awaiting-ready',
      startedAt: 1_800_000_000_000,
      sourceIdentity: { hostWindowId: 18, instanceToken: 'source-panel' },
      targetIdentity: { hostWindowId: 142, instanceToken: 'target-float' },
    };
    let bootstrapCalls = 0;
    let readyCalls = 0;
    harness.setResponse('surface.bootstrap', () => {
      bootstrapCalls += 1;
      if (bootstrapCalls === 1) return { ok: false };
      if (bootstrapCalls === 3) return { ok: true };
      return { ok: true, transaction };
    });
    harness.setResponse('surface.ready', () => {
      readyCalls += 1;
      return readyCalls === 1
        ? { ok: true, switchId: 'wrong-switch' }
        : { ok: true, switchId: 'strict-ready' };
    });

    render(<FloatingSurfaceHost deps={harness.deps} documentPip={null} />);
    const returnButton = screen.getByRole('button', { name: 'Return to Side Panel' });
    await act(async () => { await Promise.resolve(); });
    expect(returnButton).toBeDisabled();

    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(returnButton).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(returnButton).toBeDisabled();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(returnButton).toBeEnabled();
    expect(bootstrapCalls).toBe(4);
    expect(readyCalls).toBe(2);
  });

  it('requests PiP once for repeated clicks and exposes a polite busy state', async () => {
    const harness = createHarness('floatpanel');
    const pending = deferred<Window>();
    const requestWindow = vi.fn(() => pending.promise);

    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow }}
      />,
    );

    await screen.findByText('Connected');

    const button = await hydratedActivationButton();
    fireEvent.click(button);
    fireEvent.click(button);

    expect(requestWindow).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Opening always-on-top window…')).toBeVisible();
  });

  it('removes the host feed only after matching PiP readiness, even if minimization failed', async () => {
    const harness = createHarness('floatpanel');
    harness.deps.getCurrentWindowId = async () => 73;
    const pip = createPipWindow();
    let feedReady: ((eventWatermark: number) => void) | undefined;
    const mountPipFeed: MountPipFeed = vi.fn((options) => {
      feedReady = options.onFeedReady;
      return vi.fn();
    });
    render(
      <StrictMode>
        <FloatingSurfaceHost
          deps={harness.deps}
          documentPip={{ window: null, requestWindow: () => Promise.resolve(pip.pipWindow) }}
          mountPipFeed={mountPipFeed}
          createSessionId={() => 'session-73'}
        />
      </StrictMode>,
    );
    fireEvent.click(await hydratedActivationButton());

    await waitFor(() => expect(mountPipFeed).toHaveBeenCalledTimes(1));
    expect(document.querySelector('.sidepanel-root')).not.toBeNull();
    act(() => feedReady?.(42));

    await waitFor(() => expect(document.querySelector('.sidepanel-root')).toBeNull());
    expect(screen.getByText('Always-on-top window is active')).toBeVisible();
    expect(harness.sentMessages()).toContainEqual({
      protocolVersion: 1,
      type: 'pip.ready',
      payload: { sessionId: 'session-73', hostWindowId: 73, eventWatermark: 42 },
    });
  });

  it('returns from PiP with the owner issued by the opened response', async () => {
    const harness = createHarness('floatpanel');
    harness.deps.getCurrentWindowId = async () => 73;
    const pip = createPipWindow();
    let mountedFeed: PipFeedRootOptions | undefined;
    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow: () => Promise.resolve(pip.pipWindow) }}
        mountPipFeed={(options) => {
          mountedFeed = options;
          return vi.fn();
        }}
        createSessionId={() => 'session-with-owner'}
      />,
    );
    fireEvent.click(await hydratedActivationButton());
    await waitFor(() => expect(mountedFeed).toBeDefined());

    await act(async () => {
      await mountedFeed?.onReturnToSidePanel();
    });

    expect(harness.sentMessages()).toContainEqual({
      protocolVersion: 1,
      type: 'pip.returnToSidePanel',
      payload: {
        sessionId: 'session-with-owner',
        hostWindowId: 73,
        ownerWindowId: 77,
        switchId: expect.any(String),
      },
    });
  });

  it.each([
    ['target-open-failed', { ok: false, switchId: 'dynamic', reason: 'target-open-failed' }],
    ['target-ready-timeout', { ok: false, switchId: 'dynamic', reason: 'target-ready-timeout' }],
    ['missing switch id', { ok: true }],
    ['mismatched switch id', { ok: true, switchId: 'other-switch' }],
    ['extra success field', { ok: true, switchId: 'dynamic', extra: true }],
    ['rejected response', new Error('worker unavailable')],
  ])('keeps PiP return recoverable after %s', async (_label, configuredResponse) => {
    const harness = createHarness('floatpanel');
    harness.deps.getCurrentWindowId = async () => 73;
    const pip = createPipWindow();
    let mountedFeed: PipFeedRootOptions | undefined;
    const switchIds: string[] = [];
    let attempt = 0;
    harness.setResponse('pip.returnToSidePanel', (message: unknown) => {
      const id = (message as { payload: { switchId: string } }).payload.switchId;
      switchIds.push(id);
      attempt += 1;
      if (attempt === 2) return { ok: true, switchId: id };
      if (configuredResponse instanceof Error) return Promise.reject(configuredResponse);
      return {
        ...configuredResponse,
        ...('switchId' in configuredResponse && configuredResponse.switchId === 'dynamic'
          ? { switchId: id }
          : {}),
      };
    });
    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow: () => Promise.resolve(pip.pipWindow) }}
        mountPipFeed={(options) => {
          mountedFeed = options;
          return vi.fn();
        }}
        createSessionId={() => 'recoverable-session'}
      />,
    );
    fireEvent.click(await hydratedActivationButton());
    await waitFor(() => expect(mountedFeed).toBeDefined());

    await expect(mountedFeed!.onReturnToSidePanel()).resolves.toBe(false);
    expect(pip.pipWindow.closed).toBe(false);
    await expect(mountedFeed!.onReturnToSidePanel()).resolves.toBe(true);

    expect(switchIds).toHaveLength(2);
    expect(switchIds[1]).not.toBe(switchIds[0]);
  });

  it('rejects a pip.opened response with extra owner context fields', async () => {
    const harness = createHarness('floatpanel');
    harness.deps.getCurrentWindowId = async () => 73;
    harness.setResponse('pip.opened', {
      ok: true,
      created: true,
      ownerWindowId: 77,
      extra: true,
    });
    const pip = createPipWindow();
    const mountPipFeed = vi.fn<MountPipFeed>();
    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow: () => Promise.resolve(pip.pipWindow) }}
        mountPipFeed={mountPipFeed}
      />,
    );
    fireEvent.click(await hydratedActivationButton());

    expect(await screen.findByRole('button', {
      name: 'Reopen always-on-top window',
    })).toBeEnabled();
    expect(mountPipFeed).not.toHaveBeenCalled();
  });

  it('gives the mounted PiP feed sole read ownership during visual overlap', async () => {
    const harness = createHarness('floatpanel');
    harness.deps.getCurrentWindowId = async () => 74;
    const event: TradeEventV1 = {
      schemaVersion: 1,
      id: 'fomo:overlap-1',
      source: 'fomo',
      traderId: 'overlap-trader',
      traderHandle: 'overlap',
      chain: 'bsc',
      tokenAddress: '0x020bfc650a365f8bb26819deaabf3e21291018b4',
      tokenSymbol: 'ONE',
      action: 'buy',
      occurredAt: 1_799_999_940_000,
      receivedAt: 1_800_000_000_000,
    };
    const hostEvents = deferred<unknown>();
    let eventQueries = 0;
    harness.setResponse('events.query', () => {
      eventQueries += 1;
      return eventQueries === 1 ? hostEvents.promise : { ok: true, events: [event] };
    });
    const pip = createPipWindow();
    const mountPipFeed: MountPipFeed = (options) => {
      const container = document.createElement('div');
      pip.pipDocument.body.append(container);
      render(
        <SidePanelApp deps={{ ...options.deps, surface: 'pip' }} />,
        { container },
      );
      return vi.fn();
    };

    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow: () => Promise.resolve(pip.pipWindow) }}
        mountPipFeed={mountPipFeed}
      />,
    );
    await screen.findByText('Connected');
    fireEvent.click(await hydratedActivationButton());
    await waitFor(() => expect(harness.sentMessages().filter(
      (message) => (message as { type?: string }).type === 'events.markRead',
    )).toHaveLength(1));

    hostEvents.resolve({ ok: true, events: [event] });
    await act(async () => {
      await hostEvents.promise;
      await Promise.resolve();
    });
    expect(harness.sentMessages().filter(
      (message) => (message as { type?: string }).type === 'events.markRead',
    )).toHaveLength(1);
  });

  it('moves to recovery after native pagehide and allows reopening', async () => {
    const harness = createHarness('floatpanel');
    harness.deps.getCurrentWindowId = async () => 9;
    const pip = createPipWindow();
    const mountPipFeed: MountPipFeed = vi.fn(() => vi.fn());
    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow: () => Promise.resolve(pip.pipWindow) }}
        mountPipFeed={mountPipFeed}
        createSessionId={() => 'session-close'}
      />,
    );
    fireEvent.click(await hydratedActivationButton());
    await waitFor(() => expect(mountPipFeed).toHaveBeenCalledTimes(1));

    act(() => pip.dispatchPageHide());

    expect(await screen.findByRole('button', { name: 'Reopen always-on-top window' }))
      .toBeEnabled();
    expect(screen.getByRole('button', { name: 'Return to Side Panel' })).toBeEnabled();
    expect(harness.sentMessages()).toContainEqual({
      protocolVersion: 1,
      type: 'pip.closed',
      payload: { sessionId: 'session-close', hostWindowId: 9, reason: 'native-close' },
    });
  });

  it('ignores a late successful ready response after native pagehide', async () => {
    const harness = createHarness('floatpanel');
    harness.deps.getCurrentWindowId = async () => 19;
    const ready = deferred<unknown>();
    harness.setResponse('pip.ready', ready.promise);
    const pip = createPipWindow();
    let mountedFeed: PipFeedRootOptions | undefined;

    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow: () => Promise.resolve(pip.pipWindow) }}
        mountPipFeed={(options) => {
          mountedFeed = options;
          return vi.fn();
        }}
      />,
    );
    fireEvent.click(await hydratedActivationButton());
    await waitFor(() => expect(mountedFeed).toBeDefined());
    act(() => mountedFeed?.onFeedReady(12));
    await waitFor(() => expect(harness.sentMessages()).toContainEqual(
      expect.objectContaining({ type: 'pip.ready' }),
    ));

    act(() => pip.dispatchPageHide());
    expect(await screen.findByRole('button', { name: 'Reopen always-on-top window' }))
      .toBeEnabled();
    ready.resolve({ ok: true, minimized: false });
    await act(async () => {
      await ready.promise;
      await Promise.resolve();
    });

    expect(screen.queryByText('Always-on-top window is active')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reopen always-on-top window' }))
      .toBeEnabled();
  });

  it('does not mount a PiP feed when pagehide wins while host lookup is pending', async () => {
    const harness = createHarness('floatpanel');
    harness.setResponse('events.query', new Promise<unknown>(() => {}));
    const hostWindowId = deferred<number>();
    const getCurrentWindowId = vi.fn(() => hostWindowId.promise);
    harness.deps.getCurrentWindowId = getCurrentWindowId;
    const pip = createPipWindow();
    const mountPipFeed = vi.fn<MountPipFeed>();

    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow: () => Promise.resolve(pip.pipWindow) }}
        mountPipFeed={mountPipFeed}
      />,
    );
    fireEvent.click(await hydratedActivationButton());
    await waitFor(() => expect(getCurrentWindowId).toHaveBeenCalledTimes(1));
    act(() => pip.dispatchPageHide());
    hostWindowId.resolve(27);
    await act(async () => {
      await hostWindowId.promise;
      await Promise.resolve();
    });

    expect(mountPipFeed).not.toHaveBeenCalled();
    expect(harness.sentMessages().filter(
      (message) => (message as { type?: string }).type === 'pip.opened',
    )).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Reopen always-on-top window' }))
      .toBeEnabled();
  });

  it('cleans a feed returned after pagehide wins synchronously during mount', async () => {
    const harness = createHarness('floatpanel');
    harness.deps.getCurrentWindowId = async () => 29;
    const pip = createPipWindow();
    const cleanup = vi.fn();
    const mountPipFeed: MountPipFeed = () => {
      pip.dispatchPageHide();
      return cleanup;
    };

    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{
          window: null,
          requestWindow: () => Promise.resolve(pip.pipWindow),
        }}
        mountPipFeed={mountPipFeed}
      />,
    );
    fireEvent.click(await hydratedActivationButton());

    await waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
  });

  it('reports one close and never mounts when pagehide wins while pip.opened is pending', async () => {
    const harness = createHarness('floatpanel');
    harness.deps.getCurrentWindowId = async () => 29;
    const opened = deferred<unknown>();
    harness.setResponse('pip.opened', opened.promise);
    const pip = createPipWindow();
    const mountPipFeed = vi.fn<MountPipFeed>();

    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow: () => Promise.resolve(pip.pipWindow) }}
        mountPipFeed={mountPipFeed}
      />,
    );
    fireEvent.click(await hydratedActivationButton());
    await waitFor(() => expect(harness.sentMessages()).toContainEqual(
      expect.objectContaining({ type: 'pip.opened' }),
    ));

    act(() => pip.dispatchPageHide());
    opened.resolve({ ok: true, created: true, ownerWindowId: 77 });
    await act(async () => {
      await opened.promise;
      await Promise.resolve();
    });

    expect(mountPipFeed).not.toHaveBeenCalled();
    expect(harness.sentMessages().filter(
      (message) => (message as { type?: string }).type === 'pip.closed',
    )).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Reopen always-on-top window' }))
      .toBeEnabled();
  });

  it('keeps recovery gated until the closed activation settles, then starts a fresh request', async () => {
    const harness = createHarness('floatpanel');
    harness.deps.getCurrentWindowId = async () => 30;
    const opened = deferred<unknown>();
    let openedCalls = 0;
    harness.setResponse('pip.opened', () => {
      openedCalls += 1;
      return openedCalls === 1
        ? opened.promise
        : { ok: true, created: true, ownerWindowId: 77 };
    });
    const firstPip = createPipWindow();
    const secondPip = createPipWindow();
    const requestWindow = vi
      .fn<DocumentPictureInPictureLike['requestWindow']>()
      .mockResolvedValueOnce(firstPip.pipWindow)
      .mockResolvedValueOnce(secondPip.pipWindow);
    const mountPipFeed = vi.fn<MountPipFeed>(() => vi.fn());

    render(
      <StrictMode>
        <FloatingSurfaceHost
          deps={harness.deps}
          documentPip={{ window: null, requestWindow }}
          mountPipFeed={mountPipFeed}
        />
      </StrictMode>,
    );
    fireEvent.click(await hydratedActivationButton());
    await waitFor(() => expect(openedCalls).toBe(1));

    act(() => firstPip.dispatchPageHide());
    const reopen = await screen.findByRole('button', {
      name: 'Reopen always-on-top window',
    });
    expect(reopen).toBeDisabled();
    expect(reopen).toHaveAttribute('aria-busy', 'true');
    fireEvent.click(reopen);
    expect(requestWindow).toHaveBeenCalledTimes(1);

    opened.resolve({ ok: true, created: true, ownerWindowId: 77 });
    await act(async () => {
      await opened.promise;
      await Promise.resolve();
    });
    await waitFor(() => expect(reopen).toBeEnabled());

    fireEvent.click(reopen);
    await waitFor(() => expect(requestWindow).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(mountPipFeed).toHaveBeenCalledTimes(1));
  });

  it('tears down a mounted PiP feed once across host unmount and later pagehide', async () => {
    const harness = createHarness('floatpanel');
    harness.deps.getCurrentWindowId = async () => 35;
    const pip = createPipWindow();
    const cleanup = vi.fn();
    const mountPipFeed: MountPipFeed = vi.fn(() => cleanup);
    const view = render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow: () => Promise.resolve(pip.pipWindow) }}
        mountPipFeed={mountPipFeed}
      />,
    );
    fireEvent.click(await hydratedActivationButton());
    await waitFor(() => expect(mountPipFeed).toHaveBeenCalledTimes(1));

    view.unmount();
    await Promise.resolve();
    pip.dispatchPageHide();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(harness.sentMessages().filter(
      (message) => (message as { type?: string }).type === 'pip.closed',
    )).toHaveLength(1);
  });

  it('returns rejected requests to a retryable error state', async () => {
    const harness = createHarness('floatpanel');
    const pip = createPipWindow();
    const requestWindow = vi
      .fn<DocumentPictureInPictureLike['requestWindow']>()
      .mockRejectedValueOnce(new Error('denied'))
      .mockResolvedValueOnce(pip.pipWindow);

    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow }}
        mountPipFeed={() => vi.fn()}
      />,
    );
    fireEvent.click(await hydratedActivationButton());

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(requestWindow).toHaveBeenCalledTimes(2));
  });

  it('reports mount failures with the mount-failed lifecycle reason', async () => {
    const harness = createHarness('floatpanel');
    harness.deps.getCurrentWindowId = async () => 31;
    const pip = createPipWindow();

    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow: () => Promise.resolve(pip.pipWindow) }}
        mountPipFeed={() => {
          throw new Error('render failed');
        }}
        createSessionId={() => 'session-mount-failed'}
      />,
    );
    fireEvent.click(await hydratedActivationButton());

    expect(await screen.findByRole('button', { name: 'Try again' })).toBeEnabled();
    expect(harness.sentMessages()).toContainEqual({
      protocolVersion: 1,
      type: 'pip.closed',
      payload: {
        sessionId: 'session-mount-failed',
        hostWindowId: 31,
        reason: 'mount-failed',
      },
    });
  });

  it.each(['invalid', 'rejected'] as const)(
    'closes and unmounts a child whose ready response is %s, then requests a fresh child on retry',
    async (readyFailure) => {
      const harness = createHarness('floatpanel');
      harness.deps.getCurrentWindowId = async () => 52;
      if (readyFailure === 'invalid') {
        harness.setResponse('pip.ready', { ok: true, minimized: false, extra: true });
      } else {
        const sendMessage = harness.deps.runtime.sendMessage;
        harness.deps.runtime.sendMessage = async (message) => {
          if ((message as { type?: string }).type === 'pip.ready') {
            await sendMessage(message);
            throw new Error('ready rejected');
          }
          return sendMessage(message);
        };
      }
      const firstPip = createPipWindow();
      const secondPip = createPipWindow();
      const requestWindow = vi
        .fn<DocumentPictureInPictureLike['requestWindow']>()
        .mockResolvedValueOnce(firstPip.pipWindow)
        .mockResolvedValueOnce(secondPip.pipWindow);
      const cleanups = [vi.fn(), vi.fn()];
      const mountedFeeds: PipFeedRootOptions[] = [];
      const mountPipFeed: MountPipFeed = vi.fn((options) => {
        mountedFeeds.push(options);
        return cleanups[mountedFeeds.length - 1] ?? vi.fn();
      });

      render(
        <FloatingSurfaceHost
          deps={harness.deps}
          documentPip={{ window: null, requestWindow }}
          mountPipFeed={mountPipFeed}
          createSessionId={() => `ready-failure-${requestWindow.mock.calls.length}`}
        />,
      );
    fireEvent.click(await hydratedActivationButton());
      await waitFor(() => expect(mountPipFeed).toHaveBeenCalledTimes(1));

      act(() => mountedFeeds[0]?.onFeedReady(88));

      expect(await screen.findByRole('button', { name: 'Try again' })).toBeEnabled();
      expect(firstPip.pipWindow.close).toHaveBeenCalledTimes(1);
      expect(cleanups[0]).toHaveBeenCalledTimes(1);
      expect(document.querySelectorAll('.sidepanel-root')).toHaveLength(1);

      harness.setResponse('pip.ready', { ok: true, minimized: false });
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(requestWindow).toHaveBeenCalledTimes(2));
      await waitFor(() => expect(mountPipFeed).toHaveBeenCalledTimes(2));
    },
  );

  it('keeps the host noninteractive and preserves the child feed when child close fails', async () => {
    const harness = createHarness('floatpanel');
    harness.deps.getCurrentWindowId = async () => 61;
    harness.setResponse('pip.ready', { ok: false, reason: 'chrome-api-failed' });
    const pip = createPipWindow();
    vi.mocked(pip.pipWindow.close).mockImplementation(() => {
      throw new Error('close failed');
    });
    const cleanup = vi.fn();
    let mountedFeed: PipFeedRootOptions | undefined;

    render(
      <FloatingSurfaceHost
        deps={harness.deps}
        documentPip={{ window: null, requestWindow: () => Promise.resolve(pip.pipWindow) }}
        mountPipFeed={(options) => {
          mountedFeed = options;
          return cleanup;
        }}
      />,
    );
    fireEvent.click(await hydratedActivationButton());
    await waitFor(() => expect(mountedFeed).toBeDefined());

    act(() => mountedFeed?.onFeedReady(99));

    await screen.findByText('The always-on-top window could not be opened. You can try again.');
    expect(document.querySelector('.sidepanel-root')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(cleanup).not.toHaveBeenCalled();
  });
});

describe('PipFeedRoot', () => {
  it('applies the feed light theme to the PiP lifecycle bar', async () => {
    const harness = createHarness('pip');
    harness.seedStored(SETTINGS_STORAGE_KEY, {
      ...DEFAULT_SETTINGS,
      uiTheme: 'light',
    });
    const pip = createPipWindow();
    const root = pip.pipDocument.createElement('div');
    pip.pipDocument.body.append(root);

    let cleanup!: () => void;
    await act(async () => {
      cleanup = mountPipFeedRoot({
        root,
        deps: harness.deps,
        onFeedReady: vi.fn(),
        onReturnToSidePanel: vi.fn(async () => true),
      });
    });

    await waitFor(() => {
      expect(root.querySelector('.pip-feed-root')?.getAttribute('data-theme'))
        .toBe('light');
    });
    act(() => cleanup());
  });

  it('mounts the shared feed with an always-on-top indicator and return action', async () => {
    const harness = createHarness('pip');
    const pip = createPipWindow();
    const root = pip.pipDocument.createElement('div');
    pip.pipDocument.body.append(root);
    const onFeedReady = vi.fn();
    const onReturnToSidePanel = vi.fn(async () => true);

    let cleanup!: () => void;
    await act(async () => {
      cleanup = mountPipFeedRoot({
        root,
        deps: harness.deps,
        onFeedReady,
        onReturnToSidePanel,
      });
    });

    const pipUi = within(root);
    expect(pipUi.getByText('Always on top').textContent).toBe('Always on top');
    expect(root.querySelector('.sidepanel-root')).not.toBeNull();
    const returnButton = root.querySelector<HTMLButtonElement>('.pip-lifecycle-bar button');
    expect(returnButton?.textContent).toBe('Return to Side Panel');
    act(() => returnButton?.click());
    expect(onReturnToSidePanel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onFeedReady).toHaveBeenCalledWith(0));
    expect(harness.sentMessages().filter((message) => (
      (message as { type?: string }).type === 'surface.bootstrap'
    ))).toHaveLength(0);

    act(() => cleanup());
    expect(root.childNodes).toHaveLength(0);
  });

  it('shows an atomic returning state, recovers from failure, and allows retry', async () => {
    const harness = createHarness('pip');
    const pip = createPipWindow();
    const root = pip.pipDocument.createElement('div');
    pip.pipDocument.body.append(root);
    const first = deferred<boolean>();
    const second = deferred<boolean>();
    const onReturnToSidePanel = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    let cleanup!: () => void;
    await act(async () => {
      cleanup = mountPipFeedRoot({
        root,
        deps: harness.deps,
        onFeedReady: vi.fn(),
        onReturnToSidePanel,
      });
    });

    const returnButton = root.querySelector<HTMLButtonElement>('.pip-lifecycle-bar button')!;
    act(() => returnButton.click());
    expect(returnButton.textContent).toBe('Returning to Side Panel…');
    expect(returnButton.disabled).toBe(true);
    expect(returnButton.getAttribute('aria-busy')).toBe('true');
    expect(root.querySelector('[role="status"]')?.textContent)
      .toBe('Returning to Side Panel…');
    act(() => returnButton.click());
    expect(onReturnToSidePanel).toHaveBeenCalledTimes(1);

    await act(async () => first.resolve(false));
    expect(root.querySelector('[role="status"]')?.textContent).toBe('Return failed.');
    expect(returnButton.textContent).toBe('Try returning to Side Panel again');
    expect(returnButton.disabled).toBe(false);

    act(() => returnButton.click());
    expect(onReturnToSidePanel).toHaveBeenCalledTimes(2);
    expect(returnButton.textContent).toBe('Returning to Side Panel…');
    expect(returnButton.disabled).toBe(true);
    await act(async () => second.resolve(true));
    expect(returnButton.textContent).toBe('Returning to Side Panel…');
    expect(returnButton.disabled).toBe(true);

    act(() => cleanup());
  });
});
