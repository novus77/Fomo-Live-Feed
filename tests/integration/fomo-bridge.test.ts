import { describe, expect, it } from 'vitest';
import { installFomoDomActivityObserver } from '../../src/fomo/dom-activity-observer';

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

// BLOCKING 2: the interceptor's connection candidates - open carries
// authenticated:true, close carries no auth claim.
const socketOpenEnvelope = () => ({
  namespace: WINDOW_MESSAGE_NAMESPACE,
  protocolVersion: PROTOCOL_VERSION,
  type: 'connection.candidate',
  payload: { connected: true, authenticated: true },
});

const socketCloseEnvelope = () => ({
  namespace: WINDOW_MESSAGE_NAMESPACE,
  protocolVersion: PROTOCOL_VERSION,
  type: 'connection.candidate',
  payload: { connected: false },
});

const healthCandidateEnvelope = (payload: Record<string, unknown>) => ({
  namespace: WINDOW_MESSAGE_NAMESPACE,
  protocolVersion: PROTOCOL_VERSION,
  type: 'pipeline.healthCandidate',
  payload,
});

const connectionChanged = (connected: boolean, authenticated: boolean) => ({
  protocolVersion: PROTOCOL_VERSION,
  type: 'connection.changed',
  payload: { connected, authenticated, at: NOW },
});

class FakeBridgeWindow implements BridgeWindowLike {
  readonly origin: string;
  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>();

  constructor(origin: string) {
    this.origin = origin;
  }

  addEventListener(type: 'message', listener: (event: WindowMessageEventLike) => void): void;
  addEventListener(type: 'pagehide' | 'pageshow' | 'focus', listener: (event: { persisted?: boolean }) => void): void;
  addEventListener(type: string, listener: ((event: WindowMessageEventLike) => void) | ((event: { persisted?: boolean }) => void)): void {
    const bucket = this.listeners.get(type) ?? [];
    bucket.push(listener as (event?: unknown) => void);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: 'message', listener: (event: WindowMessageEventLike) => void): void;
  removeEventListener(type: 'pagehide' | 'pageshow' | 'focus', listener: (event: { persisted?: boolean }) => void): void;
  removeEventListener(type: string, listener: ((event: WindowMessageEventLike) => void) | ((event: { persisted?: boolean }) => void)): void {
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

  dispatchPageHide(persisted = false): void {
    this.dispatchLifecycle('pagehide', persisted);
  }

  dispatchLifecycle(type: 'pagehide' | 'pageshow' | 'focus', persisted = false): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({ persisted });
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
  function recoveryHarness() {
    let clock = NOW;
    const win = new FakeBridgeWindow('https://fomo.family');
    const sent: unknown[] = [];
    const requests: unknown[] = [];
    Object.assign(win, { postMessage: (message: unknown) => requests.push(message) });
    const bridge = installFomoBridge({
      window: win, sendMessage: (message) => sent.push(message), now: () => clock,
    });
    return { win, bridge, sent, requests, advance: (ms: number) => { clock += ms; } };
  }

  it('keeps initial relative-time DOM history offline and promotes only acknowledged new rows', async () => {
    const { bridge, sent, advance } = recoveryHarness();
    document.body.innerHTML = `<a href="/tokens/bnb/TokenAddress?tradeId=baseline"
      aria-label="trader Buy just now TOKEN $5 at $10K MC"></a>`;
    advance(1_500);
    const observer = installFomoDomActivityObserver({
      document, now: () => NOW + 1_500, emit: () => true,
      onLiveActivity: (activity) => bridge.noteDomActivity(activity),
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sendsOfType(sent, 'connection.changed')).toHaveLength(1);
      document.body.insertAdjacentHTML('beforeend', `<a href="/tokens/bnb/TokenAddress?tradeId=new-live"
        aria-label="trader Buy just now TOKEN $5 at $10K MC"><time datetime="${new Date(NOW + 1_500).toISOString()}"></time></a>`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sendsOfType(sent, 'connection.changed').at(-1)).toMatchObject({
        payload: { connected: true, authenticated: true },
      });
    } finally {
      observer.uninstall();
      bridge.uninstall();
    }
  });

  it('enables DOM recovery immediately after an authenticated socket closes', () => {
    const { win, bridge } = recoveryHarness();
    win.dispatchMessage({ source: win, data: socketOpenEnvelope() });
    expect(bridge.shouldUseDomFallback()).toBe(false);
    win.dispatchMessage({ source: win, data: socketCloseEnvelope() });
    expect(bridge.hasAuthenticatedCapture()).toBe(true);
    expect(bridge.shouldUseDomFallback()).toBe(true);
  });

  it('rejects DOM connection evidence that predates the latest page suspension', () => {
    const { bridge, win, sent, advance } = recoveryHarness();
    advance(2_000);
    win.dispatchPageHide(true);
    win.dispatchLifecycle('pageshow', true);
    const count = sendsOfType(sent, 'connection.changed').length;
    bridge.noteDomActivity({ ...candidatePayload, createdAt: new Date(NOW + 1_000).toISOString() });
    expect(sendsOfType(sent, 'connection.changed')).toHaveLength(count);
    bridge.uninstall();
  });

  it('enables quiet primary recovery without reporting logout or socket closure', () => {
    const { win, bridge, sent, advance } = recoveryHarness();
    win.dispatchMessage({ source: win, data: socketOpenEnvelope() });
    advance(15_000);
    expect(bridge.shouldUseDomFallback()).toBe(true);
    expect(sendsOfType(sent, 'connection.changed')).toEqual([
      connectionChanged(false, false), connectionChanged(true, true),
    ]);
    win.dispatchMessage({ source: win, data: candidateEnvelope() });
    expect(bridge.shouldUseDomFallback()).toBe(false);
    advance(14_999);
    expect(bridge.shouldUseDomFallback()).toBe(false);
  });

  it('records fallback once per primary-capture interruption without raw page data', () => {
    const { win, bridge, sent, advance } = recoveryHarness();
    win.dispatchMessage({ source: win, data: socketOpenEnvelope() });
    advance(15_000);
    bridge.shouldUseDomFallback();
    bridge.shouldUseDomFallback();
    expect(sendsOfType(sent, 'pipeline.healthEvent')).toContainEqual({
      protocolVersion: 1, type: 'pipeline.healthEvent',
      payload: { type: 'capture.recovery', reason: 'primary-quiet', at: NOW + 15_000 },
    });
    expect(sendsOfType(sent, 'pipeline.healthEvent')).toHaveLength(1);
  });

  it('restores connection from newly occurring DOM activity without disabling recovery', () => {
    const { bridge, sent } = recoveryHarness();
    bridge.noteDomActivity({ ...candidatePayload, createdAt: new Date(NOW).toISOString() });
    expect(sendsOfType(sent, 'connection.changed')).toEqual([
      connectionChanged(false, false), connectionChanged(true, true),
    ]);
    expect(bridge.shouldUseDomFallback()).toBe(true);
  });

  it('does not infer a live connection from historical or invalid DOM activity', () => {
    const { bridge, sent } = recoveryHarness();
    for (const activity of [candidatePayload, {}, { ...candidatePayload, createdAt: new Date(NOW + 60_000).toISOString() }]) {
      bridge.noteDomActivity(activity);
    }
    expect(sendsOfType(sent, 'connection.changed')).toEqual([connectionChanged(false, false)]);
  });

  it('keeps recent DOM delivery live while a socket snapshot is closed', () => {
    const { win, bridge, sent } = recoveryHarness();
    bridge.noteDomActivity({ ...candidatePayload, createdAt: new Date(NOW).toISOString() });
    win.dispatchMessage({ source: win, data: socketCloseEnvelope() });
    expect(sendsOfType(sent, 'connection.changed').at(-1)).toEqual(connectionChanged(true, true));
    expect(bridge.shouldUseDomFallback()).toBe(true);
  });

  it('does not restore a connection from an old DOM event that occurred after installation', () => {
    const { bridge, sent, advance } = recoveryHarness();
    advance(60_000);
    bridge.noteDomActivity({ ...candidatePayload, createdAt: new Date(NOW + 1_000).toISOString() });
    expect(sendsOfType(sent, 'connection.changed')).toEqual([connectionChanged(false, false)]);
  });

  it('requests fresh socket evidence when the document becomes visible', () => {
    const doc = new EventTarget();
    Object.assign(doc, { visibilityState: 'hidden' });
    const win = new FakeBridgeWindow('https://fomo.family');
    const requests: unknown[] = [];
    Object.assign(win, { postMessage: (message: unknown) => requests.push(message) });
    const bridge = installFomoBridge({ window: win, document: doc as unknown as Document,
      sendMessage: () => {}, now: () => NOW });
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(requests.filter((request) => (request as { type: string }).type === 'connection.request')).toHaveLength(0);
    Object.assign(doc, { visibilityState: 'visible' });
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(requests.at(-1)).toMatchObject({ type: 'connection.request' });
    bridge.uninstall();
    const count = requests.length;
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(requests).toHaveLength(count);
  });

  it('reconciles a cached page on resume without fabricating an open socket', () => {
    const { win, bridge, sent, requests } = recoveryHarness();
    win.dispatchMessage({ source: win, data: socketOpenEnvelope() });
    win.dispatchPageHide(true);
    win.dispatchLifecycle('pageshow', true);
    expect(sendsOfType(sent, 'connection.changed').at(-1)).toEqual(connectionChanged(false, true));
    expect(requests.at(-1)).toEqual({
      namespace: WINDOW_MESSAGE_NAMESPACE, protocolVersion: PROTOCOL_VERSION, type: 'connection.request',
    });
    expect(bridge.shouldUseDomFallback()).toBe(true);
  });

  it('republishes state on ping and removes lifecycle handlers on uninstall', () => {
    const { win, bridge, sent, requests } = recoveryHarness();
    win.dispatchMessage({ source: win, data: socketOpenEnvelope() });
    bridge.reportConnection();
    expect(sendsOfType(sent, 'connection.changed').at(-1)).toEqual(connectionChanged(true, true));
    expect(requests.at(-1)).toMatchObject({ type: 'connection.request' });
    bridge.uninstall();
    const count = sent.length;
    win.dispatchLifecycle('pageshow', true);
    win.dispatchLifecycle('focus');
    expect(sent).toHaveLength(count);
  });

  it('strictly validates and forwards closed pipeline health candidates', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({
      source: win,
      data: healthCandidateEnvelope({ type: 'frame.received', at: NOW }),
    });
    win.dispatchMessage({
      source: win,
      data: healthCandidateEnvelope({ type: 'frame.received', at: NOW, rawFrame: 'secret' }),
    });
    win.dispatchMessage({
      source: win,
      data: { ...healthCandidateEnvelope({ type: 'observer.installed' }), extra: true },
    });

    // The one well-formed candidate is forwarded; the two malformed ones are
    // never forwarded and instead produce bounded bridge-envelope evidence.
    expect(sendsOfType(sent, 'pipeline.healthEvent')).toEqual([
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'pipeline.healthEvent',
        payload: { type: 'frame.received', at: NOW },
      },
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'pipeline.healthEvent',
        payload: { type: 'activity.rejectionStage', stage: 'bridge-envelope', at: NOW },
      },
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'pipeline.healthEvent',
        payload: { type: 'activity.rejectionStage', stage: 'bridge-envelope', at: NOW },
      },
    ]);
  });

  it.each([
    { type: 'activity.accepted', at: NOW, occurredAt: NOW },
    { type: 'activity.persisted', at: NOW },
    { type: 'activity.broadcast', at: NOW },
    { type: 'activity.rejected', code: 'duplicate', at: NOW },
  ])('never forwards background-only pipeline health event %j as a candidate', (payload) => {
    const { win, sent } = createHarness();

    win.dispatchMessage({ source: win, data: healthCandidateEnvelope(payload) });

    // The background-only payload is never forwarded; its rejection becomes a
    // single bounded bridge-envelope stage event instead.
    expect(sendsOfType(sent, 'pipeline.healthEvent')).toEqual([
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'pipeline.healthEvent',
        payload: { type: 'activity.rejectionStage', stage: 'bridge-envelope', at: NOW },
      },
    ]);
  });
  it('reports page presence on load as NOT connected and NOT authenticated (BLOCKING 2)', () => {
    // The old bridge claimed connected:true on load, which made a
    // freshly-opened logged-OUT page read as a live feed. A page is only
    // connected once its authenticated socket actually opens.
    const { sent } = createHarness();

    expect(sent).toEqual([connectionChanged(false, false)]);
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

  it('recovers authenticated connection state when a verified activity arrives after socket-open was missed', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({ source: win, data: candidateEnvelope() });

    expect(sendsOfType(sent, 'connection.changed')).toEqual([
      connectionChanged(false, false),
      connectionChanged(true, true),
    ]);
  });

  it.each([null, {}, { ...candidatePayload, createdAt: 'invalid' }])(
    'keeps DOM fallback enabled for an invalid raw candidate %j',
    (payload) => {
      const win = new FakeBridgeWindow('https://fomo.family');
      const sent: unknown[] = [];
      const bridge = installFomoBridge({ window: win, sendMessage: (message) => sent.push(message), now: () => NOW });
      win.dispatchMessage({ source: win, data: candidateEnvelope(payload) });

      expect(bridge.hasAuthenticatedCapture()).toBe(false);
      expect(sendsOfType(sent, 'connection.changed')).toEqual([connectionChanged(false, false)]);
      expect(sendsOfType(sent, 'activity.ingest')).toHaveLength(1);
      bridge.uninstall();
    },
  );

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

  it('upgrades to connected+authenticated on socket open and keeps authenticated on close', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({ source: win, data: socketOpenEnvelope() });
    win.dispatchMessage({ source: win, data: socketCloseEnvelope() });

    // page-load presence, then open, then close (close keeps the sticky auth).
    expect(sendsOfType(sent, 'connection.changed')).toEqual([
      connectionChanged(false, false),
      connectionChanged(true, true),
      connectionChanged(false, true),
    ]);
  });

  it('keeps the socket authenticated across reconnects (never login-required mid-reconnect)', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({ source: win, data: socketOpenEnvelope() });
    win.dispatchMessage({ source: win, data: socketCloseEnvelope() });
    win.dispatchMessage({ source: win, data: socketOpenEnvelope() });

    expect(sendsOfType(sent, 'connection.changed')).toEqual([
      connectionChanged(false, false),
      connectionChanged(true, true),
      connectionChanged(false, true),
      connectionChanged(true, true),
    ]);
  });

  it('resets authentication on a fresh page load (no socket ever opens -> login-required)', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({ source: win, data: socketOpenEnvelope() });
    win.dispatchMessage({ source: win, data: socketCloseEnvelope() });

    // A page reload reinstalls the bridge: it reports unauthenticated until
    // the new page's socket opens.
    const second = createHarness();
    second.win.dispatchMessage({ source: second.win, data: socketCloseEnvelope() });

    expect(sendsOfType(second.sent, 'connection.changed')).toEqual([
      connectionChanged(false, false),
      connectionChanged(false, false),
    ]);
  });

  it('ignores an invalid connection candidate payload', () => {
    const { win, sent } = createHarness();

    for (const payload of [
      { connected: 'yes' },
      { connected: true, authenticated: 'yes' },
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
      connectionChanged(false, false),
    ]);
  });

  it('emits connection.changed disconnected+unauthenticated on pagehide', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({ source: win, data: socketOpenEnvelope() });
    win.dispatchPageHide();

    expect(sendsOfType(sent, 'connection.changed')).toEqual([
      connectionChanged(false, false),
      connectionChanged(true, true),
      connectionChanged(false, false),
    ]);
  });

  it('rejects spoofed connection candidates like any other message', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({
      source: win,
      data: { ...socketOpenEnvelope(), namespace: 'other' },
    });
    win.dispatchMessage({
      source: win,
      data: { ...socketOpenEnvelope(), protocolVersion: 9 },
    });
    const iframe = {} as unknown;
    win.dispatchMessage({ source: iframe, data: socketOpenEnvelope() });

    expect(sendsOfType(sent, 'connection.changed')).toEqual([
      connectionChanged(false, false),
    ]);
  });

  it('every forwarded message passes strict protocol validation', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({ source: win, data: candidateEnvelope() });
    win.dispatchMessage({ source: win, data: socketOpenEnvelope() });
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

    win.dispatchMessage({ source: win, data: socketOpenEnvelope() });
    win.dispatchPageHide();

    for (const message of sendsOfType(sent, 'connection.changed')) {
      const record = message as {
        payload: Record<string, unknown>;
      };
      expect(Object.keys(record.payload).sort()).toEqual(['at', 'authenticated', 'connected']);
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
    win.dispatchMessage({ source: win, data: socketOpenEnvelope() });
    win.dispatchPageHide();

    expect(sent).toEqual([]);
  });

  it('records a bounded bridge-envelope rejection stage for malformed Fomo envelopes', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({
      source: win,
      data: { namespace: WINDOW_MESSAGE_NAMESPACE, type: 'activity.candidate' },
    });
    win.dispatchMessage({
      source: win,
      data: {
        namespace: WINDOW_MESSAGE_NAMESPACE,
        protocolVersion: PROTOCOL_VERSION,
        type: 'connection.candidate',
        payload: { connected: 'yes' },
      },
    });

    expect(sendsOfType(sent, 'pipeline.healthEvent')).toEqual([
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'pipeline.healthEvent',
        payload: { type: 'activity.rejectionStage', stage: 'bridge-envelope', at: NOW },
      },
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'pipeline.healthEvent',
        payload: { type: 'activity.rejectionStage', stage: 'bridge-envelope', at: NOW },
      },
    ]);
  });

  it('records bridge-envelope rejections without forwarding any raw candidate data', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({
      source: win,
      data: {
        namespace: WINDOW_MESSAGE_NAMESPACE,
        type: 'activity.candidate',
        payload: {
          comment: 'secret thesis',
          tokenAddress: '0xdeadbeef00000000000000000000000000000000',
          cookie: 'session=1',
        },
        extra: 'smuggled',
      },
    });

    const events = sendsOfType(sent, 'pipeline.healthEvent');

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      protocolVersion: PROTOCOL_VERSION,
      type: 'pipeline.healthEvent',
      payload: { type: 'activity.rejectionStage', stage: 'bridge-envelope', at: NOW },
    });
    expect(JSON.stringify(events[0])).not.toContain('secret thesis');
    expect(JSON.stringify(events[0])).not.toContain('0xdeadbeef');
    expect(JSON.stringify(events[0])).not.toContain('session=1');
    expect(JSON.stringify(events[0])).not.toContain('smuggled');
  });

  it('never records bridge-envelope rejections for non-Fomo window messages', () => {
    const { win, sent } = createHarness();

    win.dispatchMessage({ source: win, data: { hello: 'world' } });
    win.dispatchMessage({ source: win, data: 'plain string' });
    win.dispatchMessage({ source: win, data: null });
    win.dispatchMessage({
      source: win,
      data: { namespace: 'other-namespace', type: 'activity.candidate' },
    });

    const iframe = {} as unknown;
    win.dispatchMessage({
      source: iframe,
      data: { namespace: WINDOW_MESSAGE_NAMESPACE, type: 'activity.candidate' },
    });

    expect(sendsOfType(sent, 'pipeline.healthEvent')).toEqual([]);
  });
});
