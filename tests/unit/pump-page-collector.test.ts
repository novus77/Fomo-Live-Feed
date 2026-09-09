import fixture from '../fixtures/pump/following-trades-page.json';
import { installPumpPageCollector } from '../../src/pump/page-collector';
import { PUMP_WINDOW_NAMESPACE } from '../../src/pump/window-protocol';

type Listener = (event: MessageEvent) => void;

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

function grant(epoch: number) {
  return {
    namespace: PUMP_WINDOW_NAMESPACE,
    protocolVersion: 1,
    type: 'pump.leaseCommand',
    payload: { granted: true, epoch, expiresAt: 20_000 },
  };
}

describe('Pump page collector', () => {
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

    await vi.advanceTimersByTimeAsync(999);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchFn).toHaveBeenCalledTimes(2);

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
});
