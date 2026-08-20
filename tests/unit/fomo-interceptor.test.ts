import { describe, expect, it } from 'vitest';

import {
  installFomoWebSocketObserver,
  type MessageEventLike,
  type WebSocketLike,
} from '../../src/fomo/websocket-observer';
import { WINDOW_MESSAGE_NAMESPACE, PROTOCOL_VERSION } from '../../src/messaging/protocol';

const FOMO_SOCKET_URL = 'wss://prod-api.fomo.family/ws';

const activityFrame = {
  type: 'data',
  topicType: 'trading_activity',
  payload: {
    id: 'activity-1',
    tradeId: 'trade-1',
    type: 'swap_buy',
    userId: 'trader-1',
    userHandle: 'alpha',
    ticker: 'FOMO',
    tokenAddress: '0x020bfc650a365f8bb26819deaabf3e21291018b4',
    networkId: 56,
    createdAt: '2026-08-20T08:15:30.000Z',
  },
} as const;

type FrameListener = (event: MessageEventLike) => void;

class FakeWS implements WebSocketLike {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readonly constructorArgs: readonly unknown[];
  readonly sent: unknown[] = [];
  onmessage: ((event: MessageEventLike) => void) | null = null;

  private readonly listeners = new Map<string, FrameListener[]>();

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.constructorArgs = [url, protocols];
  }

  addEventListener(type: 'message', listener: FrameListener): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'close', listener: () => void): void;
  addEventListener(type: string, listener: unknown): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener as FrameListener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: unknown): void {
    const bucket = this.listeners.get(type);
    if (bucket === undefined) {
      return;
    }
    const index = bucket.indexOf(listener as FrameListener);
    if (index !== -1) {
      bucket.splice(index, 1);
    }
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  emit(type: 'message', event: MessageEventLike): void;
  emit(type: 'open' | 'close', event?: undefined): void;
  emit(type: string, event?: MessageEventLike): void {
    if (type === 'message' && this.onmessage !== null && event !== undefined) {
      this.onmessage(event);
    }
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event as MessageEventLike);
    }
  }
}

interface PostedMessage {
  message: unknown;
  targetOrigin: string;
}

function createFakeWindow(origin = 'https://fomo.family'): {
  win: {
    origin: string;
    WebSocket: typeof FakeWS;
    postMessage: (message: unknown, targetOrigin: string) => void;
  };
  posted: PostedMessage[];
} {
  const posted: PostedMessage[] = [];

  const win = {
    origin,
    WebSocket: FakeWS,
    postMessage(message: unknown, targetOrigin: string): void {
      posted.push({ message, targetOrigin });
    },
  };

  return { win, posted };
}

const candidateEnvelope = (payload: unknown) => ({
  namespace: WINDOW_MESSAGE_NAMESPACE,
  protocolVersion: PROTOCOL_VERSION,
  type: 'activity.candidate',
  payload,
});

const healthEnvelope = (payload: Record<string, unknown>) => ({
  namespace: WINDOW_MESSAGE_NAMESPACE,
  protocolVersion: PROTOCOL_VERSION,
  type: 'pipeline.healthCandidate',
  payload,
});

function newSocket(
  win: { WebSocket: typeof FakeWS },
  url = FOMO_SOCKET_URL,
  protocols?: string | string[],
): FakeWS {
  return new (win.WebSocket as unknown as typeof FakeWS)(url, protocols);
}

describe('installFomoWebSocketObserver', () => {
  it('reports installation and Fomo socket observation without exposing the URL', () => {
    const { win, posted } = createFakeWindow();
    installFomoWebSocketObserver(win, () => 101);

    newSocket(win);

    expect(posted).toEqual([
      { message: healthEnvelope({ type: 'observer.installed' }), targetOrigin: win.origin },
      { message: healthEnvelope({ type: 'socket.observed', at: 101 }), targetOrigin: win.origin },
    ]);
    expect(JSON.stringify(posted)).not.toContain(FOMO_SOCKET_URL);
  });

  it('reports socket state, every inbound frame, and accepted candidates with timestamps', () => {
    const { win, posted } = createFakeWindow();
    let current = 200;
    installFomoWebSocketObserver(win, () => current++);
    const socket = newSocket(win);

    socket.emit('open');
    socket.emit('message', { data: new ArrayBuffer(8) });
    socket.emit('message', { data: JSON.stringify(activityFrame) });
    socket.emit('close');

    expect(posted.map(({ message }) => message)).toEqual([
      healthEnvelope({ type: 'observer.installed' }),
      healthEnvelope({ type: 'socket.observed', at: 200 }),
      healthEnvelope({ type: 'socket.opened', at: 201 }),
      {
        namespace: WINDOW_MESSAGE_NAMESPACE,
        protocolVersion: PROTOCOL_VERSION,
        type: 'connection.candidate',
        payload: { connected: true, authenticated: true },
      },
      healthEnvelope({ type: 'frame.received', at: 202 }),
      healthEnvelope({ type: 'frame.received', at: 203 }),
      candidateEnvelope(activityFrame.payload),
      healthEnvelope({ type: 'activity.candidate', at: 204 }),
      healthEnvelope({ type: 'socket.closed', at: 205 }),
      {
        namespace: WINDOW_MESSAGE_NAMESPACE,
        protocolVersion: PROTOCOL_VERSION,
        type: 'connection.candidate',
        payload: { connected: false },
      },
    ]);
  });

  it('does not report socket or frame health for non-Fomo sockets', () => {
    const { win, posted } = createFakeWindow();
    installFomoWebSocketObserver(win, () => 300);
    const socket = newSocket(win, 'wss://api.other-site.example/ws');

    socket.emit('message', { data: new Blob(['secret']) });
    socket.emit('open');
    socket.emit('close');

    expect(posted).toEqual([
      { message: healthEnvelope({ type: 'observer.installed' }), targetOrigin: win.origin },
    ]);
  });
  it('replaces window.WebSocket with a wrapper and restores the original on uninstall', () => {
    const { win } = createFakeWindow();

    const uninstall = installFomoWebSocketObserver(win);

    expect(win.WebSocket).not.toBe(FakeWS);
    expect(typeof win.WebSocket).toBe('function');

    uninstall();

    expect(win.WebSocket).toBe(FakeWS);
  });

  it('passes constructor arguments through to the original class', () => {
    const { win } = createFakeWindow();
    installFomoWebSocketObserver(win);

    const socket = newSocket(win, FOMO_SOCKET_URL, ['chat', 'ws']);

    expect(socket.constructorArgs).toEqual([FOMO_SOCKET_URL, ['chat', 'ws']]);
  });

  it('preserves prototype identity so instances still use the original prototype', () => {
    const { win } = createFakeWindow();
    installFomoWebSocketObserver(win);

    const socket = newSocket(win);

    expect(Object.getPrototypeOf(socket)).toBe(FakeWS.prototype);
    expect(socket instanceof FakeWS).toBe(true);
  });

  it('keeps instanceof working through the page WebSocket reference', () => {
    const { win } = createFakeWindow();
    installFomoWebSocketObserver(win);

    const socket = newSocket(win);

    expect(socket instanceof win.WebSocket).toBe(true);
  });

  it('preserves the static readyState constants', () => {
    const { win } = createFakeWindow();
    installFomoWebSocketObserver(win);

    expect(win.WebSocket.CONNECTING).toBe(FakeWS.CONNECTING);
    expect(win.WebSocket.OPEN).toBe(FakeWS.OPEN);
    expect(win.WebSocket.CLOSING).toBe(FakeWS.CLOSING);
    expect(win.WebSocket.CLOSED).toBe(FakeWS.CLOSED);
  });

  it('preserves the constructor name and length', () => {
    const { win } = createFakeWindow();
    installFomoWebSocketObserver(win);

    expect(win.WebSocket.name).toBe(FakeWS.name);
    expect(win.WebSocket.length).toBe(FakeWS.length);
  });

  it('forwards a valid trading_activity frame exactly once with the page origin as target', () => {
    const { win, posted } = createFakeWindow();
    installFomoWebSocketObserver(win);

    const socket = newSocket(win);
    socket.emit('message', { data: JSON.stringify(activityFrame) });

    expect(posted).toEqual([
      {
        message: candidateEnvelope(activityFrame.payload),
        targetOrigin: 'https://fomo.family',
      },
    ]);
  });

  it('never uses "*" as the postMessage target origin', () => {
    const { win, posted } = createFakeWindow();
    installFomoWebSocketObserver(win);

    const socket = newSocket(win);
    socket.emit('message', { data: JSON.stringify(activityFrame) });
    socket.emit('open');
    socket.emit('close');

    for (const entry of posted) {
      expect(entry.targetOrigin).not.toBe('*');
    }
  });

  it('ignores sockets that are not the Fomo production socket', () => {
    const { win, posted } = createFakeWindow();
    installFomoWebSocketObserver(win);

    const foreign = newSocket(win, 'wss://api.other-site.example/ws');
    foreign.emit('message', { data: JSON.stringify(activityFrame) });
    foreign.emit('open');
    foreign.emit('close');

    expect(posted).toEqual([]);
  });

  it('ignores sockets on a different host or path', () => {
    const { win, posted } = createFakeWindow();
    installFomoWebSocketObserver(win);

    for (const url of [
      'wss://prod-api.fomo.family/other',
      'wss://staging-api.fomo.family/ws',
      'wss://prod-api.fomo.family.evil.com/ws',
      'http://prod-api.fomo.family/ws',
      'wss://prod-api.fomo.family',
      'not a url',
    ]) {
      const socket = newSocket(win, url);
      socket.emit('message', { data: JSON.stringify(activityFrame) });
    }

    expect(posted).toEqual([]);
  });

  it('ignores non-string inbound data such as Blob and ArrayBuffer', () => {
    const { win, posted } = createFakeWindow();
    installFomoWebSocketObserver(win);

    const socket = newSocket(win);
    socket.emit('message', { data: new Blob([JSON.stringify(activityFrame)]) });
    socket.emit('message', { data: new ArrayBuffer(8) });
    socket.emit('message', { data: null });
    socket.emit('message', { data: 42 });

    expect(posted).toEqual([]);
  });

  it('ignores invalid JSON and empty strings', () => {
    const { win, posted } = createFakeWindow();
    installFomoWebSocketObserver(win);

    const socket = newSocket(win);
    socket.emit('message', { data: '{not valid json' });
    socket.emit('message', { data: '' });
    socket.emit('message', { data: 'null' });
    socket.emit('message', { data: '[]' });

    expect(posted).toEqual([]);
  });

  it('forwards a candidate frame payload verbatim even when it is not an object', () => {
    const { win, posted } = createFakeWindow();
    installFomoWebSocketObserver(win);

    const socket = newSocket(win);
    socket.emit('message', { data: JSON.stringify({ type: 'data', topicType: 'trading_activity', payload: null }) });

    expect(posted).toEqual([
      {
        message: candidateEnvelope(null),
        targetOrigin: 'https://fomo.family',
      },
    ]);
  });

  it.each([
    [{ type: 'message', topicType: 'trading_activity', payload: activityFrame.payload }],
    [{ type: 'data', topicType: 'other_topic', payload: activityFrame.payload }],
    [{ type: 'data' }],
    [{ topicType: 'trading_activity', payload: activityFrame.payload }],
    [{ type: 'data', topicType: 'trading_activity' }],
    ['data'],
    [null],
  ])('ignores frames that are not type "data" with topicType "trading_activity": %j', (frame) => {
    const { win, posted } = createFakeWindow();
    installFomoWebSocketObserver(win);

    const socket = newSocket(win);
    socket.emit('message', { data: JSON.stringify(frame) });

    expect(posted).toEqual([]);
  });

  it('forwards connection state on open and close for the Fomo socket only', () => {
    const { win, posted } = createFakeWindow();
    installFomoWebSocketObserver(win);

    const socket = newSocket(win);
    const foreign = newSocket(win, 'wss://api.other-site.example/ws');

    socket.emit('open');
    socket.emit('close');
    foreign.emit('open');
    foreign.emit('close');

    // BLOCKING 2: the OPEN observation carries authenticated:true (an
    // unauthenticated page cannot open the authenticated socket), while close
    // carries no auth claim so the bridge's sticky flag survives reconnects.
    expect(posted).toEqual([
      {
        message: {
          namespace: WINDOW_MESSAGE_NAMESPACE,
          protocolVersion: PROTOCOL_VERSION,
          type: 'connection.candidate',
          payload: { connected: true, authenticated: true },
        },
        targetOrigin: 'https://fomo.family',
      },
      {
        message: {
          namespace: WINDOW_MESSAGE_NAMESPACE,
          protocolVersion: PROTOCOL_VERSION,
          type: 'connection.candidate',
          payload: { connected: false },
        },
        targetOrigin: 'https://fomo.family',
      },
    ]);
  });

  it('installing twice is idempotent: one wrapper and exactly one forward per frame', () => {
    const { win, posted } = createFakeWindow();
    const firstUninstall = installFomoWebSocketObserver(win);
    const secondUninstall = installFomoWebSocketObserver(win);

    const socket = newSocket(win);
    socket.emit('message', { data: JSON.stringify(activityFrame) });
    socket.emit('open');

    expect(Object.getPrototypeOf(socket)).toBe(FakeWS.prototype);
    expect(posted).toEqual([
      {
        message: candidateEnvelope(activityFrame.payload),
        targetOrigin: 'https://fomo.family',
      },
      {
        message: {
          namespace: WINDOW_MESSAGE_NAMESPACE,
          protocolVersion: PROTOCOL_VERSION,
          type: 'connection.candidate',
          payload: { connected: true, authenticated: true },
        },
        targetOrigin: 'https://fomo.family',
      },
    ]);

    firstUninstall();
    secondUninstall();

    expect(win.WebSocket).toBe(FakeWS);
  });

  it('uninstall stops observing new sockets', () => {
    const { win, posted } = createFakeWindow();
    const uninstall = installFomoWebSocketObserver(win);

    const before = newSocket(win);
    before.emit('message', { data: JSON.stringify(activityFrame) });

    uninstall();

    const after = newSocket(win);
    after.emit('message', { data: JSON.stringify(activityFrame) });

    expect(win.WebSocket).toBe(FakeWS);
    expect(posted).toHaveLength(1);
  });

  it('does not disturb page event delivery order', () => {
    const { win, posted } = createFakeWindow();
    installFomoWebSocketObserver(win);

    const socket = newSocket(win);
    const order: string[] = [];

    socket.addEventListener('message', () => {
      order.push('page-handler-1');
    });
    socket.addEventListener('message', () => {
      order.push('page-handler-2');
    });

    socket.emit('message', { data: JSON.stringify(activityFrame) });

    expect(order).toEqual(['page-handler-1', 'page-handler-2']);
    expect(posted).toHaveLength(1);
  });

  it('still delivers events to a page onmessage handler', () => {
    const { win } = createFakeWindow();
    installFomoWebSocketObserver(win);

    const socket = newSocket(win);
    const received: unknown[] = [];

    socket.onmessage = (event) => {
      received.push(event.data);
    };

    socket.emit('message', { data: JSON.stringify(activityFrame) });

    expect(received).toEqual([JSON.stringify(activityFrame)]);
  });

  it('a failure inside the observer never breaks the page socket handling', () => {
    const { win } = createFakeWindow();
    win.postMessage = () => {
      throw new Error('boom');
    };
    installFomoWebSocketObserver(win);

    const socket = newSocket(win);
    const received: unknown[] = [];

    socket.addEventListener('message', (event) => {
      received.push(event.data);
    });

    expect(() => socket.emit('message', { data: JSON.stringify(activityFrame) })).not.toThrow();
    expect(received).toEqual([JSON.stringify(activityFrame)]);
  });

  it('never reads or forwards outbound send payloads', () => {
    const { win, posted } = createFakeWindow();
    installFomoWebSocketObserver(win);

    const socket = newSocket(win);
    socket.send(JSON.stringify({ token: 'secret-auth-token', message: 'hello' }));

    expect(socket.sent).toHaveLength(1);
    expect(posted).toEqual([]);
  });

  it('throws an Illegal constructor error when called without new, like the native API', () => {
    const { win } = createFakeWindow();
    installFomoWebSocketObserver(win);

    const Wrapped = win.WebSocket as unknown as { (url: string): void };

    expect(() => Wrapped(FOMO_SOCKET_URL)).toThrowError(TypeError);
  });

  it('forwards nothing when the page origin is not an allowed Fomo origin', () => {
    const { win, posted } = createFakeWindow('https://evil.example');
    installFomoWebSocketObserver(win);

    const socket = newSocket(win);
    socket.emit('message', { data: JSON.stringify(activityFrame) });
    socket.emit('open');

    expect(posted).toEqual([]);
  });
});
