import fixture from '../fixtures/pump/following-trades-page.json';
import { installPumpPageCollector } from '../../src/pump/page-collector';
import { PUMP_WINDOW_NAMESPACE } from '../../src/pump/window-protocol';
import { PumpPollingSession } from '../../src/pump/polling-session';
import { parsePumpTradePage, type RawPumpTrade } from '../../src/pump/raw-schema';

type Listener = (event: MessageEvent) => void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createCollectorWindow() {
  const listeners = new Set<Listener>();
  const posted: unknown[] = [];
  const win = {
    location: { origin: 'https://pump.fun' },
    postMessage(message: unknown) {
      posted.push(message);
    },
    addEventListener(_type: 'message', listener: Listener) {
      listeners.add(listener);
    },
    removeEventListener(_type: 'message', listener: Listener) {
      listeners.delete(listener);
    },
  };

  return {
    win,
    posted,
    dispatch(data: unknown) {
      for (const listener of listeners) listener({ source: win, data } as unknown as MessageEvent);
    },
  };
}

function grant(epoch: number, workerSessionId = 'worker-a', expiresAt = Date.now() + 20_000) {
  return {
    namespace: PUMP_WINDOW_NAMESPACE,
    protocolVersion: 1,
    type: 'pump.leaseCommand',
    payload: { granted: true, workerSessionId, epoch, expiresAt },
  };
}

describe('Pump page collector', () => {
  it('forwards the terminal catch-up reason through the page bridge', async () => {
    vi.setSystemTime(new Date('2026-09-09T02:00:10Z'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...fixture, nextCursor: null }), { status: 200 })));
    const target = createCollectorWindow();
    const collector = installPumpPageCollector(target.win);
    const lease = grant(1);
    target.dispatch({ ...lease, payload: { ...lease.payload, seed: { watermark: '1399811149:missing', recentKeys: [] } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(target.posted).toEqual(expect.arrayContaining([expect.objectContaining({
      message: expect.objectContaining({ type: 'pump.status', payload: expect.objectContaining({
        status: 'possible-gap', gapReason: 'endpoint-ended',
      }) }),
    })]));
    collector.uninstall();
  });
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('uses the first page only as a watermark and polls serially', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    const target = createCollectorWindow();
    const collector = installPumpPageCollector(target.win);

    target.dispatch(grant(1));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(target.posted).toEqual(expect.arrayContaining([
      expect.objectContaining({
        message: expect.objectContaining({
          type: 'pump.batch',
          payload: expect.objectContaining({ epoch: 1, items: [] }),
        }),
      }),
    ]));

    const firstBatch = target.posted.find((candidate) => (
      (candidate as { message?: { type?: string } }).message?.type === 'pump.batch'
    )) as { message: { payload: { batchId: string } } };
    target.dispatch({
      namespace: PUMP_WINDOW_NAMESPACE,
      protocolVersion: 1,
      type: 'pump.batchAck',
      payload: { epoch: 1, batchId: firstBatch.message.payload.batchId, ok: true },
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    collector.uninstall();
  });

  it('keeps undelivered catch-up chunks recoverable from each acknowledged checkpoint', async () => {
    const base = parsePumpTradePage(fixture).accepted[0]!;
    const now = Date.now();
    const item = (tx: string, offset: number): RawPumpTrade => ({
      ...base,
      createdAt: new Date(now - offset).toISOString(),
      trade: { ...base.trade, tx, timestamp: new Date(now - offset).toISOString() },
    });
    const old = item('old', 1_000);
    const newest = Array.from({ length: 101 }, (_, index) => item(`new-${index}`, index));
    const pages = [
      { items: newest.slice(0, 100), nextCursor: 'older' },
      { items: [newest[100], old], nextCursor: null },
    ];
    let request = 0;
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(pages[request++]), { status: 200 }));
    const target = createCollectorWindow();
    const collector = installPumpPageCollector(target.win);
    const oldKey = `${old.chainId}:old`;
    target.dispatch({
      ...grant(1),
      payload: { ...grant(1).payload, seed: { watermark: oldKey, recentKeys: [oldKey] } },
    });
    await vi.advanceTimersByTimeAsync(5);

    type Batch = {
      message: {
        type: string;
        payload: { batchId: string; watermark?: string; recentKeys: string[]; items: RawPumpTrade[] };
      };
    };
    const batches = () => target.posted.filter((candidate) =>
      (candidate as Batch).message?.type === 'pump.batch') as Batch[];
    const first = batches()[0]!;
    const resumed = new PumpPollingSession({ startedAt: now, seed: first.message.payload });
    const firstPage = parsePumpTradePage(pages[0]);
    const secondPage = parsePumpTradePage(pages[1]);
    const resumeStart = resumed.acceptNewestPage(firstPage);
    const recovered = resumeStart.status === 'catching-up'
      ? resumed.acceptCatchUpPage(secondPage)
      : resumeStart;

    expect(first.message.payload.watermark).toBe(oldKey);
    expect(first.message.payload.recentKeys).not.toContain(`${old.chainId}:new-0`);
    expect(recovered).toEqual({ status: 'events', delivery: 'recovered', items: [newest[0]] });
    expect(batches()).toHaveLength(1);

    target.dispatch({
      namespace: PUMP_WINDOW_NAMESPACE,
      protocolVersion: 1,
      type: 'pump.batchAck',
      payload: { epoch: 1, batchId: first.message.payload.batchId, ok: true },
    });
    expect(batches()).toHaveLength(2);
    expect(batches()[1]!.message.payload.watermark).toBe(`${old.chainId}:new-0`);
    collector.uninstall();
  });

  it('does not publish a stale failure after leadership changes mid-request', async () => {
    let rejectFirst: ((reason?: unknown) => void) | undefined;
    const fetchFn = vi.fn((_: string | URL | Request, init?: RequestInit) => {
      if (fetchFn.mock.calls.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          rejectFirst = reject;
          init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        });
      }
      return Promise.resolve(new Response(JSON.stringify(fixture), { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchFn);
    const target = createCollectorWindow();
    const collector = installPumpPageCollector(target.win);

    target.dispatch(grant(1));
    await vi.advanceTimersByTimeAsync(0);
    target.dispatch(grant(2));
    rejectFirst?.(new Error('stale request'));
    await vi.advanceTimersByTimeAsync(0);

    const messages = target.posted
      .map((candidate) => (candidate as { message?: { payload?: { epoch?: number; status?: string } } }).message)
      .filter(Boolean);
    expect(messages).not.toContainEqual(expect.objectContaining({
      payload: expect.objectContaining({ epoch: 1, status: 'delayed' }),
    }));
    expect(messages).toContainEqual(expect.objectContaining({
      type: 'pump.status',
      payload: expect.objectContaining({ epoch: 2, status: 'live' }),
    }));

    collector.uninstall();
  });

  it('accepts a lower epoch from a replacement worker session without a page reload', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    const target = createCollectorWindow();
    const collector = installPumpPageCollector(target.win);

    target.dispatch(grant(2, 'worker-old'));
    await vi.advanceTimersByTimeAsync(0);
    target.dispatch(grant(1, 'worker-new'));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    collector.uninstall();
  });

  it('renews a replacement worker reusing a terminal epoch while blocking the terminal worker', async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockImplementation(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    const target = createCollectorWindow();
    const collector = installPumpPageCollector(target.win);

    target.dispatch(grant(1, 'worker-a'));
    await vi.advanceTimersByTimeAsync(0);
    expect(target.posted).toContainEqual(expect.objectContaining({
      message: expect.objectContaining({ type: 'pump.status', payload: expect.objectContaining({
        workerSessionId: 'worker-a', status: 'authentication-required',
      }) }),
    }));
    target.dispatch(grant(1, 'worker-a'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    target.dispatch(grant(1, 'worker-b', Date.now() + 500));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const batch = target.posted.find((candidate) =>
      (candidate as { message?: { type?: string } }).message?.type === 'pump.batch'
    ) as { message: { payload: { batchId: string } } };
    target.dispatch({
      namespace: PUMP_WINDOW_NAMESPACE,
      protocolVersion: 1,
      type: 'pump.batchAck',
      payload: { epoch: 1, batchId: batch.message.payload.batchId, ok: true },
    });
    target.dispatch(grant(1, 'worker-b'));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(target.posted).not.toContainEqual(expect.objectContaining({
      message: expect.objectContaining({ type: 'pump.status', payload: expect.objectContaining({
        workerSessionId: 'worker-b', status: 'disconnected',
      }) }),
    }));
    collector.uninstall();
  });

  it('ignores an old success when a replacement worker reuses the epoch', async () => {
    const base = fixture.items[0]!;
    const oldPage = { ...fixture, items: [{ ...base, trade: { ...base.trade, tx: 'obsolete-only' } }] };
    const replacementPage = { ...fixture, items: [{ ...base, trade: { ...base.trade, tx: 'replacement-only' } }] };
    const oldKey = `${base.chainId}:obsolete-only`;
    const replacementKey = `${base.chainId}:replacement-only`;
    const oldRequest = deferred<Response>();
    const replacementRequest = deferred<Response>();
    const fetchFn = vi.fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(replacementRequest.promise)
      .mockResolvedValue(new Response(JSON.stringify(replacementPage), { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    const target = createCollectorWindow();
    const collector = installPumpPageCollector(target.win);

    target.dispatch(grant(1, 'worker-old'));
    await vi.advanceTimersByTimeAsync(0);
    target.dispatch(grant(1, 'worker-new'));
    await vi.advanceTimersByTimeAsync(0);
    oldRequest.resolve(new Response(JSON.stringify(oldPage), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(target.posted).toEqual([]);
    target.dispatch(grant(1, 'worker-new'));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchFn).toHaveBeenCalledTimes(2);

    replacementRequest.resolve(new Response(JSON.stringify(replacementPage), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    const batch = target.posted.find((candidate) =>
      (candidate as { message?: { type?: string } }).message?.type === 'pump.batch'
    ) as { message: { payload: {
      batchId: string; items: unknown[]; workerSessionId: string; watermark: string; recentKeys: string[];
    } } };
    expect(batch.message.payload).toMatchObject({
      workerSessionId: 'worker-new', items: [], watermark: replacementKey, recentKeys: [replacementKey],
    });
    expect(batch.message.payload.recentKeys).not.toContain(oldKey);
    target.dispatch({
      namespace: PUMP_WINDOW_NAMESPACE,
      protocolVersion: 1,
      type: 'pump.batchAck',
      payload: { epoch: 1, batchId: batch.message.payload.batchId, ok: true },
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    collector.uninstall();
  });

  it.each(['authentication', 'network'] as const)(
    'ignores an old %s failure when a replacement worker reuses the epoch',
    async (failure) => {
      const oldRequest = deferred<Response>();
      const replacementRequest = deferred<Response>();
      let replacementSignal: AbortSignal | undefined;
      const fetchFn = vi.fn()
        .mockReturnValueOnce(oldRequest.promise)
        .mockImplementationOnce((_url: string, init?: RequestInit) => {
          replacementSignal = init?.signal ?? undefined;
          return replacementRequest.promise;
        });
      vi.stubGlobal('fetch', fetchFn);
      const target = createCollectorWindow();
      const collector = installPumpPageCollector(target.win);

      target.dispatch(grant(1, 'worker-old'));
      await vi.advanceTimersByTimeAsync(0);
      target.dispatch(grant(1, 'worker-new'));
      await vi.advanceTimersByTimeAsync(0);
      if (failure === 'authentication') oldRequest.resolve(new Response(null, { status: 401 }));
      else oldRequest.reject(new Error('Connection closed'));
      await vi.advanceTimersByTimeAsync(0);

      expect(target.posted).toEqual([]);
      expect(replacementSignal?.aborted).toBe(false);
      replacementRequest.resolve(new Response(JSON.stringify(fixture), { status: 200 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(target.posted).toContainEqual(expect.objectContaining({
        message: expect.objectContaining({ type: 'pump.status', payload: expect.objectContaining({
          workerSessionId: 'worker-new', status: 'live', backoffLevel: 0,
        }) }),
      }));
      collector.uninstall();
    },
  );

  it.each(['success', 'authentication', 'network'] as const)('ignores an old %s after the same worker resets an expired polling session', async (outcome) => {
    const oldRequest = deferred<Response>();
    const replacementRequest = deferred<Response>();
    const fetchFn = vi.fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(replacementRequest.promise);
    vi.stubGlobal('fetch', fetchFn);
    const target = createCollectorWindow();
    const collector = installPumpPageCollector(target.win);

    target.dispatch(grant(1, 'worker-a', Date.now() + 1));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1);
    target.dispatch(grant(1, 'worker-a'));
    await vi.advanceTimersByTimeAsync(0);
    target.posted.length = 0;
    if (outcome === 'network') oldRequest.reject(new Error('Old request failed'));
    else oldRequest.resolve(new Response(JSON.stringify(fixture), { status: outcome === 'success' ? 200 : 401 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(target.posted).toEqual([]);
    replacementRequest.resolve(new Response(JSON.stringify(fixture), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(target.posted).toContainEqual(expect.objectContaining({
      message: expect.objectContaining({ type: 'pump.batch', payload: expect.objectContaining({ items: [] }) }),
    }));
    expect(target.posted).toContainEqual(expect.objectContaining({
      message: expect.objectContaining({ type: 'pump.status', payload: expect.objectContaining({ status: 'live', backoffLevel: 0 }) }),
    }));
    expect(fetchFn).toHaveBeenCalledTimes(2);
    collector.uninstall();
  });

  it('retains the recovery cursor and committed checkpoint after a network failure and gates unique ascending chunks on ACK', async () => {
    const base = parsePumpTradePage(fixture).accepted[0]!;
    const now = Date.now();
    const item = (tx: string, offset: number): RawPumpTrade => ({
      ...base,
      createdAt: new Date(now - offset).toISOString(),
      trade: { ...base.trade, tx, timestamp: new Date(now - offset).toISOString() },
    });
    const old = item('committed', 1_000);
    const newest = Array.from({ length: 101 }, (_, index) => item(`recovery-${index}`, index));
    const oldKey = `${old.chainId}:committed`;
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: newest.slice(0, 100), nextCursor: 'older' }), { status: 200 }))
      .mockRejectedValueOnce(new Error('Network unavailable'))
      .mockResolvedValueOnce(new Response(JSON.stringify({ items: [newest[99], newest[100], old], nextCursor: null }), { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    const target = createCollectorWindow();
    const collector = installPumpPageCollector(target.win);
    type Batch = { message: { type: string; payload: { batchId: string; watermark?: string; recentKeys: string[]; items: RawPumpTrade[] } } };
    const batches = () => target.posted.filter((candidate) => (candidate as Batch).message?.type === 'pump.batch') as Batch[];
    try {
      const lease = grant(1);
      target.dispatch({ ...lease, payload: { ...lease.payload, seed: { watermark: oldKey, recentKeys: [oldKey] } } });
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchFn).toHaveBeenCalledTimes(2);
      expect(batches()).toEqual([]);
      expect(target.posted).toContainEqual(expect.objectContaining({
        message: expect.objectContaining({ type: 'pump.status', payload: expect.objectContaining({ status: 'delayed' }) }),
      }));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchFn).toHaveBeenCalledTimes(3);
      expect(new URL(String(fetchFn.mock.calls[1]![0])).searchParams.get('cursor')).toBe('older');
      expect(new URL(String(fetchFn.mock.calls[2]![0])).searchParams.get('cursor')).toBe('older');
      expect(batches()).toHaveLength(1);
      const first = batches()[0]!.message.payload;
      expect(first.watermark).toBe(oldKey);
      expect(first.recentKeys).toContain(oldKey);
      expect(first.recentKeys).not.toContain(`${old.chainId}:recovery-0`);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchFn).toHaveBeenCalledTimes(3);
      expect(batches()).toHaveLength(1);
      target.dispatch({ namespace: PUMP_WINDOW_NAMESPACE, protocolVersion: 1, type: 'pump.batchAck', payload: { epoch: 1, batchId: first.batchId, ok: true } });
      expect(batches()).toHaveLength(2);
      const recovered = batches().flatMap((batch) => batch.message.payload.items);
      expect(recovered.map((trade) => trade.trade.tx)).toEqual([...newest].reverse().map((trade) => trade.trade.tx));
      expect(new Set(recovered.map((trade) => trade.trade.tx)).size).toBe(101);
      expect(batches()[1]!.message.payload.watermark).toBe(`${old.chainId}:recovery-0`);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(fetchFn).toHaveBeenCalledTimes(3);
    } finally {
      collector.uninstall();
      random.mockRestore();
    }
  });

  it.each(['success', 'failure'] as const)('uninstalls during catch-up without timers or late %s posts', async (outcome) => {
    vi.setSystemTime(new Date('2026-09-09T02:00:10Z'));
    const request = deferred<Response>();
    let requestSignal: AbortSignal | undefined;
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...fixture, nextCursor: 'older' }), { status: 200 }))
      .mockImplementationOnce((_url: string, init?: RequestInit) => {
        requestSignal = init?.signal ?? undefined;
        return request.promise;
      });
    vi.stubGlobal('fetch', fetchFn);
    const target = createCollectorWindow();
    const collector = installPumpPageCollector(target.win);
    const lease = grant(1);
    target.dispatch({ ...lease, payload: { ...lease.payload, seed: { watermark: 'missing', recentKeys: ['missing'] } } });
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    collector.uninstall();
    expect(requestSignal?.aborted).toBe(true);
    const postedBeforeCompletion = [...target.posted];
    if (outcome === 'success') request.resolve(new Response(JSON.stringify({ ...fixture, nextCursor: null }), { status: 200 }));
    else request.reject(new Error('Late network failure'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(target.posted).toEqual(postedBeforeCompletion);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not expire a replacement lease when an obsolete request completes', async () => {
    const oldRequest = deferred<Response>();
    const replacementRequest = deferred<Response>();
    const fetchFn = vi.fn()
      .mockReturnValueOnce(oldRequest.promise)
      .mockReturnValueOnce(replacementRequest.promise);
    vi.stubGlobal('fetch', fetchFn);
    const target = createCollectorWindow();
    const collector = installPumpPageCollector(target.win);

    target.dispatch(grant(1, 'worker-old'));
    await vi.advanceTimersByTimeAsync(0);
    target.dispatch(grant(1, 'worker-new', Date.now() + 1));
    await vi.advanceTimersByTimeAsync(0);
    vi.setSystemTime(Date.now() + 2);
    oldRequest.resolve(new Response(JSON.stringify(fixture), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(target.posted).toEqual([]);
    collector.uninstall();
    replacementRequest.resolve(new Response(JSON.stringify(fixture), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
  });

  it('accepts an in-flight response after its lease is renewed without resetting the session', async () => {
    const request = deferred<Response>();
    const fetchFn = vi.fn().mockReturnValue(request.promise);
    vi.stubGlobal('fetch', fetchFn);
    const target = createCollectorWindow();
    const collector = installPumpPageCollector(target.win);

    target.dispatch(grant(1, 'worker-a', Date.now() + 10));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5);
    target.dispatch(grant(1, 'worker-a'));
    await vi.advanceTimersByTimeAsync(5);
    request.resolve(new Response(JSON.stringify(fixture), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(target.posted).toContainEqual(expect.objectContaining({
      message: expect.objectContaining({ type: 'pump.status', payload: expect.objectContaining({ status: 'live' }) }),
    }));
    collector.uninstall();
  });

  it('does not start a request after its lease has expired', async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    const target = createCollectorWindow();
    const collector = installPumpPageCollector(target.win);

    target.dispatch(grant(1, 'worker-a', Date.now()));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchFn).not.toHaveBeenCalled();
    collector.uninstall();
  });

  it('drops an unacknowledged batch when the next lease arrives after expiry', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    const target = createCollectorWindow();
    const collector = installPumpPageCollector(target.win);

    target.dispatch(grant(1, 'worker-a', Date.now() + 1));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1);
    target.dispatch(grant(1, 'worker-a', Date.now() + 20_000));
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchFn).toHaveBeenCalledTimes(2);
    collector.uninstall();
  });

  it('retries from the last committed snapshot after a rejected batch acknowledgement', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    const target = createCollectorWindow();
    const collector = installPumpPageCollector(target.win);

    target.dispatch(grant(1));
    await vi.advanceTimersByTimeAsync(0);
    const batch = target.posted.find((candidate) => (
      (candidate as { message?: { type?: string } }).message?.type === 'pump.batch'
    )) as { message: { payload: { batchId: string } } };
    target.dispatch({
      namespace: PUMP_WINDOW_NAMESPACE,
      protocolVersion: 1,
      type: 'pump.batchAck',
      payload: { epoch: 1, batchId: batch.message.payload.batchId, ok: false },
    });

    await vi.advanceTimersByTimeAsync(250);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    collector.uninstall();
  });

  it('retries when a batch acknowledgement is lost', async () => {
    const fetchFn = vi.fn(async () => new Response(JSON.stringify(fixture), { status: 200 }));
    vi.stubGlobal('fetch', fetchFn);
    const target = createCollectorWindow();
    const collector = installPumpPageCollector(target.win);

    target.dispatch(grant(1));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(5_250);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    collector.uninstall();
  });
});
