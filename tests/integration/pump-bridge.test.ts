import { installPumpBridge } from '../../src/pump/bridge';
import { PUMP_WINDOW_NAMESPACE, pumpRuntimeCandidate } from '../../src/pump/window-protocol';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function leaseReply() {
  return { ok: true, granted: true, workerSessionId: 'worker-test', epoch: 7, expiresAt: 10_000 };
}

describe('Pump isolated bridge', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requests and renews a lease, then forwards only validated Pump messages', async () => {
    const pumpWindow = createPumpWindow();
    const sendMessage = vi.fn(async (message: unknown) => {
      const type = (message as { type?: string }).type;
      if (type === 'pump.lease.request') {
        return {
          ok: true,
          granted: true,
          workerSessionId: 'worker-test',
          epoch: 7,
          expiresAt: 10_000,
        };
      }
      return { ok: true };
    });
    const bridge = installPumpBridge({ window: pumpWindow.window, sendMessage });
    await vi.advanceTimersByTimeAsync(0);

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'pump.lease.request' }));
    expect(pumpWindow.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      namespace: PUMP_WINDOW_NAMESPACE,
      type: 'pump.leaseCommand',
    }), 'https://pump.fun');

    const status = {
      protocolVersion: 1 as const,
      type: 'pump.status' as const,
      payload: { epoch: 7, status: 'live' as const, at: 1, backoffLevel: 0 },
    };
    pumpWindow.dispatchMessage(pumpRuntimeCandidate(status));
    await Promise.resolve();
    expect(sendMessage).toHaveBeenCalledWith(status);

    pumpWindow.dispatchMessage({ namespace: PUMP_WINDOW_NAMESPACE, type: 'not-valid' });
    expect(sendMessage).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendMessage).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'pump.lease.request',
      payload: expect.objectContaining({ epoch: 7 }),
    }));

    bridge.uninstall();
  });

  it('reports pagehide only after a lease was granted', async () => {
    const pumpWindow = createPumpWindow();
    const sendMessage = vi.fn(async () => ({
      ok: true,
      granted: true,
      workerSessionId: 'worker-test',
      epoch: 3,
      expiresAt: 10_000,
    }));
    const bridge = installPumpBridge({ window: pumpWindow.window, sendMessage });
    await vi.advanceTimersByTimeAsync(0);
    pumpWindow.dispatchPageHide();
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pump.pageHidden',
      payload: expect.objectContaining({ epoch: 3 }),
    }));

    bridge.uninstall();
  });

  it('keeps lease requests single-flight until the current request completes', async () => {
    const pendingLease = deferred<unknown>();
    const pumpWindow = createPumpWindow();
    const sendMessage = vi.fn()
      .mockReturnValueOnce(pendingLease.promise)
      .mockResolvedValue(leaseReply());
    const bridge = installPumpBridge({ window: pumpWindow.window, sendMessage });

    await vi.advanceTimersByTimeAsync(6_000);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    pendingLease.resolve(leaseReply());
    await vi.advanceTimersByTimeAsync(0);
    expect(pumpWindow.postMessage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendMessage).toHaveBeenCalledTimes(2);
    bridge.uninstall();
  });

  it('does not post a deferred lease reply after uninstall', async () => {
    const pendingLease = deferred<unknown>();
    const pumpWindow = createPumpWindow();
    const sendMessage = vi.fn().mockReturnValue(pendingLease.promise);
    const bridge = installPumpBridge({ window: pumpWindow.window, sendMessage });

    bridge.uninstall();
    pendingLease.resolve(leaseReply());
    await vi.advanceTimersByTimeAsync(4_000);

    expect(pumpWindow.postMessage).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('releases the lease request guard after rejection so the next tick retries', async () => {
    const pendingLease = deferred<unknown>();
    const pumpWindow = createPumpWindow();
    const sendMessage = vi.fn()
      .mockReturnValueOnce(pendingLease.promise)
      .mockResolvedValue(leaseReply());
    const bridge = installPumpBridge({ window: pumpWindow.window, sendMessage });

    await vi.advanceTimersByTimeAsync(2_000);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    pendingLease.reject(new Error('Worker suspended'));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(pumpWindow.postMessage).toHaveBeenCalledTimes(1);
    bridge.uninstall();
  });

  it('does not post a deferred batch acknowledgement after uninstall', async () => {
    const pendingBatch = deferred<unknown>();
    const pumpWindow = createPumpWindow();
    const sendMessage = vi.fn((message: unknown) =>
      (message as { type?: string }).type === 'pump.batch'
        ? pendingBatch.promise
        : Promise.resolve(leaseReply()));
    const bridge = installPumpBridge({ window: pumpWindow.window, sendMessage });
    await vi.advanceTimersByTimeAsync(0);
    pumpWindow.postMessage.mockClear();
    pumpWindow.dispatchMessage(pumpRuntimeCandidate({
      protocolVersion: 1,
      type: 'pump.batch',
      payload: {
        epoch: 7, workerSessionId: 'worker-test', batchId: '7:1', delivery: 'live',
        items: [], recentKeys: [], possibleGap: false, at: 1,
      },
    }));

    bridge.uninstall();
    pendingBatch.resolve({ ok: true });
    await vi.advanceTimersByTimeAsync(0);

    expect(pumpWindow.postMessage).not.toHaveBeenCalled();
  });
});

function createPumpWindow() {
  const listeners = new Map<string, Set<EventListener>>();
  const target = {
    location: { origin: 'https://pump.fun' },
    postMessage: vi.fn(),
    addEventListener(type: string, listener: EventListener) {
      const bucket = listeners.get(type) ?? new Set<EventListener>();
      bucket.add(listener);
      listeners.set(type, bucket);
    },
    removeEventListener(type: string, listener: EventListener) {
      listeners.get(type)?.delete(listener);
    },
  };

  return {
    window: target as unknown as Window,
    postMessage: target.postMessage,
    dispatchMessage(data: unknown) {
      for (const listener of listeners.get('message') ?? []) {
        listener({ source: target, data } as unknown as Event);
      }
    },
    dispatchPageHide() {
      for (const listener of listeners.get('pagehide') ?? []) {
        listener(new Event('pagehide'));
      }
    },
  };
}
