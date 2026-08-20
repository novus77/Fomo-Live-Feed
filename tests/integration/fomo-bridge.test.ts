import { describe, expect, it } from 'vitest';

import {
  installFomoBridge,
  type BridgeWindowLike,
  type WindowMessageEventLike,
} from '../../src/fomo/bridge';
import {
  parseExtensionMessage,
  PROTOCOL_VERSION,
  WINDOW_MESSAGE_NAMESPACE,
} from '../../src/messaging/protocol';

const NOW = 1_800_000_000_000;

const candidatePayload = {
  id: 'activity-1',
  tradeId: 'trade-1',
  type: 'swap_buy',
  userId: 'trader-1',
  userHandle: 'alpha',
  ticker: 'FOMO',
  tokenAddress: '0x020bfc650a365f8bb26819deaabf3e21291018b4',
  networkId: 56,
  createdAt: '2026-08-20T08:15:30.000Z',
} as const;

const candidateEnvelope = (payload: unknown = candidatePayload) => ({
  namespace: WINDOW_MESSAGE_NAMESPACE,
  protocolVersion: PROTOCOL_VERSION,
  type: 'activity.candidate',
  payload,
});

const connectionEnvelope = (connected: boolean) => ({
  namespace: WINDOW_MESSAGE_NAMESPACE,
  protocolVersion: PROTOCOL_VERSION,
  type: 'connection.candidate',
  payload: { connected },
});

class FakeBridgeWindow implements BridgeWindowLike {
  readonly origin: string;
  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>();

  constructor(origin: string) {
    this.origin = origin;
  }

  addEventListener(type: 'message', listener: (event: WindowMessageEventLike) => void): void;
  addEventListener(type: 'pagehide', listener: () => void): void;
  addEventListener(type: string, listener: (event: WindowMessageEventLike) => void): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener as (event?: unknown) => void);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: 'message', listener: (event: WindowMessageEventLike) => void): void;
  removeEventListener(type: 'pagehide', listener: () => void): void;
  removeEventListener(type: string, listener: (event: WindowMessageEventLike) => void): void {
    const bucket = this.listeners.get(type);
    if (bucket === undefined) {
      return;
    }
    const index = bucket.indexOf(listener as (event?: unknown) => void);
    if (index !== -1) {
      bucket.splice(index, 1);
    }
  }

  dispatchMessage(event: WindowMessageEventLike): void {
    for (const listener of [...(this.listeners.get('message') ?? [])]) {
      listener(event);
    }
  }

  dispatchPageHide(): void {
    for (const listener of [...(this.listeners.get('pagehide') ?? [])]) {
      listener();
    }
  }
}

function createHarness(origin = 'https://fomo.family'): {
  win: FakeBridgeWindow;
  sent: unknown[];
  uninstall: () => void;
} {
  const win = new FakeBridgeWindow(origin);
  const sent: unknown[] = [];

  const bridge = installFomoBridge({
    window: win,
    sendMessage: (message: unknown) => {
      sent.push(message);
    },
    now: () => NOW,
  });

  return { win, sent, uninstall: () => bridge.uninstall() };
}

const sendsOfType = (sent: unknown[], type: string): unknown[] =>
  sent.filter(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: unknown }).type === type,
  );

describe('installFomoBridge', () => {
  it('emits connection.changed connected on page load', () => {
    const { sent } = createHarness();

    expect(sent).toEqual([
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'connection.changed',
        payload: { connected: true, at: NOW },
      },
    ]);
  });

  it('forwards a valid activity candidate to the mocked runtime exactly once', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({ source: win, data: candidateEnvelope() });

    expect(sendsOfType(sent, 'activity.ingest')).toEqual([
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'activity.ingest',
        payload: candidatePayload,
      },
    ]);
  });

  it('forwards an unknown candidate payload verbatim without extracting fields', () => {
    const { win, sent } = createHarness();

    const hostilePayload = {
      type: 'message',
      payload: candidatePayload,
      cookie: 'session=secret',
      authorization: 'Bearer top-secret',
      token: 'auth-token',
    };

    win.dispatchMessage({ source: win, data: candidateEnvelope(hostilePayload) });

    expect(sendsOfType(sent, 'activity.ingest')).toEqual([
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'activity.ingest',
        payload: hostilePayload,
      },
    ]);
  });

  it('ignores a spoofed namespace', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({
      source: win,
      data: { ...candidateEnvelope(), namespace: 'other-namespace' },
    });

    expect(sendsOfType(sent, 'activity.ingest')).toEqual([]);
  });

  it('ignores a wrong protocol version', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({
      source: win,
      data: { ...candidateEnvelope(), protocolVersion: 2 },
    });

    expect(sendsOfType(sent, 'activity.ingest')).toEqual([]);
  });

  it('ignores a wrong message type', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({
      source: win,
      data: { ...candidateEnvelope(), type: 'other.type' },
    });

    expect(sendsOfType(sent, 'activity.ingest')).toEqual([]);
  });

  it('ignores a message from a different source (simulated iframe)', () => {
    const { win, sent } = createHarness();

    const iframe = {} as unknown;
    win.dispatchMessage({ source: iframe, data: candidateEnvelope() });
    win.dispatchMessage({ source: null, data: candidateEnvelope() });

    expect(sendsOfType(sent, 'activity.ingest')).toEqual([]);
  });

  it('ignores an envelope with smuggled extra fields', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({
      source: win,
      data: { ...candidateEnvelope(), extra: 'smuggled' },
    });

    expect(sendsOfType(sent, 'activity.ingest')).toEqual([]);
  });

  it('ignores a candidate without a payload', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({
      source: win,
      data: {
        namespace: WINDOW_MESSAGE_NAMESPACE,
        protocolVersion: PROTOCOL_VERSION,
        type: 'activity.candidate',
      },
    });

    expect(sendsOfType(sent, 'activity.ingest')).toEqual([]);
  });

  it('installs nowhere on a non-Fomo page origin and forwards nothing', () => {
    const { win, sent } = createHarness('https://evil.example');

    win.dispatchMessage({ source: win, data: candidateEnvelope() });

    expect(sent).toEqual([]);
  });

  it('emits connection.changed on observed open and close', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({ source: win, data: connectionEnvelope(true) });
    win.dispatchMessage({ source: win, data: connectionEnvelope(false) });

    expect(sendsOfType(sent, 'connection.changed')).toEqual([
      { protocolVersion: PROTOCOL_VERSION, type: 'connection.changed', payload: { connected: true, at: NOW } },
      { protocolVersion: PROTOCOL_VERSION, type: 'connection.changed', payload: { connected: true, at: NOW } },
      { protocolVersion: PROTOCOL_VERSION, type: 'connection.changed', payload: { connected: false, at: NOW } },
    ]);
  });

  it('ignores an invalid connection candidate payload', () => {
    const { win, sent } = createHarness();

    for (const payload of [
      { connected: 'yes' },
      { connected: true, at: NOW },
      {},
      null,
      undefined,
    ]) {
      win.dispatchMessage({
        source: win,
        data: {
          namespace: WINDOW_MESSAGE_NAMESPACE,
          protocolVersion: PROTOCOL_VERSION,
          type: 'connection.candidate',
          ...(payload === undefined ? {} : { payload }),
        },
      });
    }

    expect(sendsOfType(sent, 'connection.changed')).toEqual([
      { protocolVersion: PROTOCOL_VERSION, type: 'connection.changed', payload: { connected: true, at: NOW } },
    ]);
  });

  it('emits connection.changed disconnected on pagehide', () => {
    const { win, sent } = createHarness();

    win.dispatchPageHide();

    expect(sendsOfType(sent, 'connection.changed')).toEqual([
      { protocolVersion: PROTOCOL_VERSION, type: 'connection.changed', payload: { connected: true, at: NOW } },
      { protocolVersion: PROTOCOL_VERSION, type: 'connection.changed', payload: { connected: false, at: NOW } },
    ]);
  });

  it('rejects spoofed connection candidates like any other message', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({
      source: win,
      data: { ...connectionEnvelope(true), namespace: 'other' },
    });
    win.dispatchMessage({
      source: win,
      data: { ...connectionEnvelope(true), protocolVersion: 9 },
    });
    const iframe = {} as unknown;
    win.dispatchMessage({ source: iframe, data: connectionEnvelope(true) });

    expect(sendsOfType(sent, 'connection.changed')).toEqual([
      { protocolVersion: PROTOCOL_VERSION, type: 'connection.changed', payload: { connected: true, at: NOW } },
    ]);
  });

  it('every forwarded message passes strict protocol validation', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({ source: win, data: candidateEnvelope() });
    win.dispatchMessage({ source: win, data: connectionEnvelope(true) });
    win.dispatchMessage({ source: win, data: candidateEnvelope() });
    win.dispatchPageHide();

    expect(sent.length).toBeGreaterThan(0);

    for (const message of sent) {
      const parsed = parseExtensionMessage(message);
      expect(parsed.ok).toBe(true);
    }
  });

  it('never forwards credential-bearing fields inside connection state', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({ source: win, data: connectionEnvelope(true) });
    win.dispatchPageHide();

    for (const message of sendsOfType(sent, 'connection.changed')) {
      const record = message as {
        payload: Record<string, unknown>;
      };
      expect(Object.keys(record.payload).sort()).toEqual(['at', 'connected']);
      expect(record.payload).not.toHaveProperty('cookie');
      expect(record.payload).not.toHaveProperty('headers');
      expect(record.payload).not.toHaveProperty('token');
      expect(record.payload).not.toHaveProperty('url');
    }
  });

  it('stops forwarding after uninstall', () => {
    const { win, sent, uninstall } = createHarness();

    // Ignore the connection.changed emitted at page load, then uninstall.
    sent.length = 0;
    uninstall();

    win.dispatchMessage({ source: win, data: candidateEnvelope() });
    win.dispatchMessage({ source: win, data: connectionEnvelope(true) });
    win.dispatchPageHide();

    expect(sent).toEqual([]);
  });
});
