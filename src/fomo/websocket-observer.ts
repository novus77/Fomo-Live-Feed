import type {
  ConnectionCandidateEnvelope,
  PipelineHealthCandidateEnvelope,
  ObserverPipelineHealthEvent,
} from '../messaging/protocol';

// Keep the document_start interceptor dependency-free. Importing the shared
// protocol module pulls in runtime schema validation and delays installation
// long enough for Fomo's startup request to win the race.
const PROTOCOL_VERSION = 1 as const;
const WINDOW_MESSAGE_NAMESPACE = 'fomo-live-feed';
const ALLOWED_FOMO_ORIGINS = new Set([
  'https://fomo.family',
  'https://www.fomo.family',
]);

function isAllowedFomoOrigin(origin: string): boolean {
  return ALLOWED_FOMO_ORIGINS.has(origin);
}

/**
 * MAIN-world WebSocket observer for the Fomo production socket.
 *
 * installFomoWebSocketObserver replaces the page's window.WebSocket with a
 * wrapper that is deliberately transparent: constructor arguments are passed
 * through, the instance's prototype IS the original class's prototype (so
 * instanceof and Object.getPrototypeOf behave exactly as before), static
 * readyState constants and the constructor name/length are preserved, and
 * event delivery to the page's own handlers is untouched. The only added
 * behavior is that inbound message frames of the Fomo production socket are
 * inspected and candidate trading_activity frames are forwarded to the
 * isolated bridge through a namespaced window.postMessage envelope.
 *
 * Outbound send() payloads are never read, logged, or forwarded: auth tokens
 * live there. Only the socket URL (origin + path, never query values) is used
 * to decide whether a socket is the Fomo production socket.
 */

// Design spec section 3 pins the production socket. The URL is matched by
// origin and path only, so query parameters (which may carry session tokens we
// must never read) do not prevent observation.
export const FOMO_SOCKET_ORIGIN = 'wss://prod-api.fomo.family';
export const FOMO_SOCKET_PATH = '/ws';

// Every wrapper we install is registered here so installing twice on the same
// window never double-wraps. A WeakSet keeps no module-level state alive
// across tests or pages.
const INSTALLED_WRAPPERS = new WeakSet<object>();
const INSTALLED_SOCKET_PROTOTYPES = new WeakSet<object>();
const INSTALLED_FETCH_WRAPPERS = new WeakSet<object>();
const INSTALLED_XHR_PROTOTYPES = new WeakSet<object>();
const BRIDGE_REPLAY_LIMIT = 100;
const BRIDGE_REPLAY_STATES = new WeakMap<object, {
  ready: boolean;
  pending: unknown[];
}>();

const NOOP_UNINSTALL: () => void = () => {};

export interface MessageEventLike {
  data: unknown;
}

/** The subset of WebSocket the observer relies on, so unit tests need no real browser. */
export interface WebSocketLike {
  readonly url: string;
  addEventListener(type: 'message', listener: (event: MessageEventLike) => void): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'close', listener: () => void): void;
}

export interface WebSocketConstructorLike<Instance extends WebSocketLike = WebSocketLike> {
  new (url: string, protocols?: string | string[]): Instance;
  readonly prototype: Instance;
  readonly CONNECTING: number;
  readonly OPEN: number;
  readonly CLOSING: number;
  readonly CLOSED: number;
  readonly name: string;
  readonly length: number;
}

/** The subset of window the observer needs, injectable in unit tests. */
export interface ObserverWindowLike {
  readonly origin: string;
  WebSocket: WebSocketConstructorLike;
  postMessage(message: unknown, targetOrigin: string): void;
}

export function installFomoBridgeReplay(
  win: ObserverWindowLike & {
    addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
    removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  },
): () => void {
  if (BRIDGE_REPLAY_STATES.has(win)) return NOOP_UNINSTALL;

  const state = { ready: false, pending: [] as unknown[] };
  BRIDGE_REPLAY_STATES.set(win, state);
  const onMessage = (event: MessageEvent): void => {
    const data = event.data as Record<string, unknown> | null;
    if (
      (event.source as unknown) !== win
      || data?.namespace !== WINDOW_MESSAGE_NAMESPACE
      || data.protocolVersion !== PROTOCOL_VERSION
      || data.type !== 'bridge.ready'
    ) return;

    state.ready = true;
    const pending = state.pending.splice(0);
    for (const payload of pending) postActivityCandidate(win, payload);
  };
  win.addEventListener('message', onMessage);

  return () => {
    win.removeEventListener('message', onMessage);
    BRIDGE_REPLAY_STATES.delete(win);
  };
}

type FetchLike = typeof globalThis.fetch;

export interface FetchObserverWindowLike {
  readonly origin: string;
  fetch: FetchLike;
  postMessage(message: unknown, targetOrigin: string): void;
}

interface XhrLike {
  readonly status: number;
  readonly responseType: XMLHttpRequestResponseType;
  readonly responseText: string;
  readonly response: unknown;
  open(method: string, url: string | URL, ...args: unknown[]): void;
  send(body?: Document | XMLHttpRequestBodyInit | null): void;
  addEventListener(type: string, listener: () => void): void;
}

interface XhrConstructorLike {
  new (): XhrLike;
  readonly prototype: XhrLike;
}

export interface XhrObserverWindowLike {
  readonly origin: string;
  XMLHttpRequest: XhrConstructorLike;
  postMessage(message: unknown, targetOrigin: string): void;
}

/**
 * Observes Fomo's own authenticated trading-activity list response.
 *
 * This fills the startup/reconnect gap without reading credentials or issuing
 * another authenticated request: the page receives its original Response and
 * Promise unchanged, while a cloned response is validated by the existing
 * bridge and ingestion pipeline.
 */
export function installFomoActivityFetchObserver(
  win: FetchObserverWindowLike,
): () => void {
  const original = win.fetch;

  if (typeof original !== 'function' || INSTALLED_FETCH_WRAPPERS.has(original)) {
    return NOOP_UNINSTALL;
  }

  const wrapped: FetchLike = function observedFomoFetch(
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit,
  ) {
    const result = original.call(this, input, init);

    if (isTradingActivityRequest(input)) {
      void result.then((response) => {
        void observeTradingActivityResponse(response, win);
      }).catch(() => {
        // The page owns fetch failures; observation must remain invisible.
      });
    }

    return result;
  };

  INSTALLED_FETCH_WRAPPERS.add(wrapped);
  win.fetch = wrapped;

  return function uninstall(): void {
    if (win.fetch === wrapped) {
      win.fetch = original;
    }
  };
}

/** Observes the Axios/XHR startup feed used by the current Fomo web app. */
export function installFomoActivityXhrObserver(
  win: XhrObserverWindowLike,
): () => void {
  const prototype = win.XMLHttpRequest?.prototype;

  if (prototype === undefined || INSTALLED_XHR_PROTOTYPES.has(prototype)) {
    return NOOP_UNINSTALL;
  }

  const originalOpen = prototype.open;
  const originalSend = prototype.send;
  const requestUrls = new WeakMap<object, unknown>();

  function observedOpen(this: XhrLike, method: string, url: string | URL, ...args: unknown[]): void {
    requestUrls.set(this, url);
    Reflect.apply(originalOpen, this, [method, url, ...args]);
  }

  function observedSend(this: XhrLike, body?: Document | XMLHttpRequestBodyInit | null): void {
    if (isTradingActivityRequest(requestUrls.get(this))) {
      this.addEventListener('loadend', () => {
        if (this.status < 200 || this.status >= 300) return;

        try {
          const parsed = this.responseType === 'json'
            ? this.response
            : JSON.parse(this.responseText);
          for (const item of extractTradingActivityItems(parsed)) {
            forwardActivityCandidate(win, item);
          }
        } catch {
          // Observation is best-effort and must not affect the page request.
        }
      });
    }

    Reflect.apply(originalSend, this, [body]);
  }

  prototype.open = observedOpen;
  prototype.send = observedSend;
  INSTALLED_XHR_PROTOTYPES.add(prototype);

  return function uninstall(): void {
    if (prototype.open === observedOpen) prototype.open = originalOpen;
    if (prototype.send === observedSend) prototype.send = originalSend;
    INSTALLED_XHR_PROTOTYPES.delete(prototype);
  };
}

function isTradingActivityRequest(input: unknown): boolean {
  const rawUrl = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.href
      : typeof input === 'object' && input !== null && 'url' in input
        ? (input as { url?: unknown }).url
        : undefined;

  if (typeof rawUrl !== 'string') {
    return false;
  }

  try {
    const url = new URL(rawUrl, 'https://fomo.family');
    return (
      ['fomo.family', 'www.fomo.family', 'prod-api.fomo.family'].includes(url.hostname)
      && url.pathname === '/feed/tradingActivity'
    );
  } catch {
    return false;
  }
}

async function observeTradingActivityResponse(
  response: Response,
  win: FetchObserverWindowLike,
): Promise<void> {
  try {
    const body = await response.clone().json();
    const items = extractTradingActivityItems(body);

    for (const item of items) {
      forwardActivityCandidate(win, item);
    }
  } catch {
    // Cloning/parsing must never affect the response consumed by the page.
  }
}

function extractTradingActivityItems(body: unknown): readonly unknown[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return [];
  }

  const record = body as Record<string, unknown>;
  const page = typeof record.responseObject === 'object'
    && record.responseObject !== null
    && !Array.isArray(record.responseObject)
    ? record.responseObject as Record<string, unknown>
    : record;

  if (Array.isArray(page.items)) return page.items;
  if (Array.isArray(page.activities)) return page.activities;
  return [];
}

export function isFomoSocketUrl(rawUrl: unknown): boolean {
  if (typeof rawUrl !== 'string') {
    return false;
  }

  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  return url.origin === FOMO_SOCKET_ORIGIN && url.pathname === FOMO_SOCKET_PATH;
}

/**
 * Installs the transparent WebSocket wrapper and returns an uninstall that
 * restores the original constructor. Never throws: an unusable or already
 * wrapped constructor yields a no-op uninstall.
 */
export function installFomoWebSocketObserver(
  win: ObserverWindowLike,
  now?: () => number,
): () => void {
  const Original = win.WebSocket;
  const openSockets = new Set<WebSocketLike>();

  if (typeof Original !== 'function') {
    return NOOP_UNINSTALL;
  }

  if (INSTALLED_WRAPPERS.has(Original)) {
    return NOOP_UNINSTALL;
  }

  // A plain function (not a class) so that Wrapper.prototype can be aliased to
  // the original prototype: instances keep the page's exact prototype chain.
  const Wrapper = function WrappedFomoWebSocket(
    this: WebSocketLike,
    ...args: unknown[]
  ): WebSocketLike {
    const newTarget = new.target as Function | undefined;

    if (newTarget === undefined) {
      throw new TypeError('Illegal constructor');
    }

    const socket = Reflect.construct(Original, args, newTarget) as WebSocketLike;

    try {
      observeSocket(socket, win, now, openSockets);
    } catch {
      // A failure inside the observer must never break the page's socket.
    }

    return socket;
  };

  // Prototype identity: the wrapper's prototype IS the original prototype, so
  // Object.getPrototypeOf(socket) === Original.prototype and instanceof
  // resolves through the page's WebSocket reference exactly as before.
  Wrapper.prototype = Original.prototype;

  // Preserve static members (CONNECTING/OPEN/CLOSING/CLOSED and anything else
  // the constructor exposes) and the observable name/length metadata.
  for (const key of Object.getOwnPropertyNames(Original)) {
    if (key === 'prototype' || key === 'name' || key === 'length') {
      continue;
    }

    const descriptor = Object.getOwnPropertyDescriptor(Original, key);

    if (descriptor !== undefined) {
      Object.defineProperty(Wrapper, key, descriptor);
    }
  }

  Object.defineProperty(Wrapper, 'name', { value: Original.name, configurable: true });
  Object.defineProperty(Wrapper, 'length', { value: Original.length, configurable: true });

  INSTALLED_WRAPPERS.add(Wrapper);

  win.WebSocket = Wrapper as unknown as WebSocketConstructorLike;

  if (now !== undefined) {
    forwardHealthCandidate(win, { type: 'observer.installed' });
  }

  return function uninstall(): void {
    if ((win.WebSocket as unknown) === (Wrapper as unknown)) {
      win.WebSocket = Original;
    }
  };
}

/**
 * Observes sockets without replacing window.WebSocket.
 *
 * The current Fomo client compares the WebSocket constructor with a pristine
 * iframe realm and bypasses patched constructors. Wrapping the prototype's
 * listener registration keeps constructor identity intact while attaching our
 * observer synchronously before the page registers its first socket listener.
 */
export function installFomoWebSocketListenerObserver(
  win: ObserverWindowLike,
  now?: () => number,
): () => void {
  const prototype = win.WebSocket?.prototype;
  if (prototype === undefined || INSTALLED_SOCKET_PROTOTYPES.has(prototype)) {
    return NOOP_UNINSTALL;
  }

  const originalAddEventListener = prototype.addEventListener;
  const observed = new WeakSet<object>();
  const openSockets = new Set<WebSocketLike>();

  function attach(socket: WebSocketLike): void {
    if (observed.has(socket) || !isFomoSocketUrl(socket.url)) return;
    observed.add(socket);

    if (now !== undefined) {
      forwardHealthCandidate(win, { type: 'socket.observed', at: now() });
    }

    Reflect.apply(originalAddEventListener, socket, ['message', (event: MessageEventLike) => {
      try {
        if (now !== undefined) forwardHealthCandidate(win, { type: 'frame.received', at: now() });
        handleInboundMessage(event, win, now);
      } catch {
        // Observation must never affect page event dispatch.
      }
    }]);
    Reflect.apply(originalAddEventListener, socket, ['open', () => {
      openSockets.add(socket);
      if (now !== undefined) forwardHealthCandidate(win, { type: 'socket.opened', at: now() });
      forwardConnectionCandidate(win, { connected: true, authenticated: true });
    }]);
    Reflect.apply(originalAddEventListener, socket, ['close', () => {
      const wasOpen = openSockets.delete(socket);
      if (now !== undefined) forwardHealthCandidate(win, { type: 'socket.closed', at: now() });
      if (wasOpen && openSockets.size === 0) forwardConnectionCandidate(win, { connected: false });
    }]);
  }

  function observedAddEventListener(
    this: WebSocketLike,
    type: 'message' | 'open' | 'close',
    listener: ((event: MessageEventLike) => void) | (() => void),
  ): void {
    attach(this);
    Reflect.apply(originalAddEventListener, this, [type, listener]);
  }

  prototype.addEventListener = observedAddEventListener as WebSocketLike['addEventListener'];
  INSTALLED_SOCKET_PROTOTYPES.add(prototype);
  if (now !== undefined) forwardHealthCandidate(win, { type: 'observer.installed' });

  return () => {
    if (prototype.addEventListener === observedAddEventListener) {
      prototype.addEventListener = originalAddEventListener;
    }
    INSTALLED_SOCKET_PROTOTYPES.delete(prototype);
  };
}

function observeSocket(
  socket: WebSocketLike,
  win: ObserverWindowLike,
  now?: () => number,
  openSockets?: Set<WebSocketLike>,
): void {
  if (!isFomoSocketUrl(socket.url)) {
    return;
  }

  if (now !== undefined) {
    forwardHealthCandidate(win, { type: 'socket.observed', at: now() });
  }

  socket.addEventListener('message', (event) => {
    try {
      if (now !== undefined) {
        forwardHealthCandidate(win, { type: 'frame.received', at: now() });
      }
      handleInboundMessage(event, win, now);
    } catch {
      // Never throw into page event dispatch.
    }
  });

  socket.addEventListener('open', () => {
    try {
      openSockets?.add(socket);
      if (now !== undefined) {
        forwardHealthCandidate(win, { type: 'socket.opened', at: now() });
      }
      // BLOCKING 2: the authenticated socket OPENING is the auth signal. An
      // unauthenticated page cannot open the authenticated socket, so this
      // observation is an honest "the user is logged in" fact without ever
      // reading cookies, headers, or tokens (spec section 9).
      forwardConnectionCandidate(win, { connected: true, authenticated: true });
    } catch {
      // Never throw into page event dispatch.
    }
  });

  socket.addEventListener('close', () => {
    try {
      if (now !== undefined) {
        forwardHealthCandidate(win, { type: 'socket.closed', at: now() });
      }
      // Close carries no auth claim: the bridge keeps its sticky
      // authenticated flag, so a reconnect is never reported as
      // login-required.
      const wasOpen = openSockets?.delete(socket) ?? true;
      if (wasOpen && (openSockets === undefined || openSockets.size === 0)) {
        forwardConnectionCandidate(win, { connected: false });
      }
    } catch {
      // Never throw into page event dispatch.
    }
  });
}

function handleInboundMessage(
  event: MessageEventLike,
  win: ObserverWindowLike,
  now?: () => number,
): void {
  const data = event.data;

  if (typeof data !== 'string') {
    return;
  }

  let frame: unknown;

  try {
    frame = JSON.parse(data);
  } catch {
    return;
  }

  const payload = extractTradingActivityPayload(frame);

  if (payload === undefined) {
    return;
  }

  forwardActivityCandidate(win, payload);
  if (now !== undefined) {
    forwardHealthCandidate(win, { type: 'activity.candidate', at: now() });
  }
}

function extractTradingActivityPayload(frame: unknown): unknown | undefined {
  if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
    return undefined;
  }

  const record = frame as Record<string, unknown>;

  if (record.type === 'data' && record.topicType === 'trading_activity') {
    return record.payload;
  }

  return findActivityPayload(record, 0);
}

function findActivityPayload(value: unknown, depth: number): unknown | undefined {
  if (depth > 4 || typeof value !== 'object' || value === null) return undefined;

  if (!Array.isArray(value) && isActivityPayload(value as Record<string, unknown>)) {
    return value;
  }

  const children = Array.isArray(value)
    ? value.slice(0, 20)
    : Object.values(value as Record<string, unknown>).slice(0, 20);
  for (const child of children) {
    const activity = findActivityPayload(child, depth + 1);
    if (activity !== undefined) return activity;
  }
  return undefined;
}

function isActivityPayload(value: Record<string, unknown>): boolean {
  return (
    typeof value.type === 'string'
    && typeof value.userId === 'string'
    && typeof value.userHandle === 'string'
    && typeof value.ticker === 'string'
    && typeof value.tokenAddress === 'string'
    && typeof value.networkId === 'number'
    && typeof value.createdAt === 'string'
  );
}

function forwardActivityCandidate(
  win: Pick<ObserverWindowLike, 'origin' | 'postMessage'>,
  payload: unknown,
): void {
  if (!isAllowedFomoOrigin(win.origin)) {
    return;
  }

  postActivityCandidate(win, payload);
}

function postActivityCandidate(
  win: Pick<ObserverWindowLike, 'origin' | 'postMessage'>,
  payload: unknown,
): void {
  win.postMessage(
    {
      namespace: WINDOW_MESSAGE_NAMESPACE,
      protocolVersion: PROTOCOL_VERSION,
      type: 'activity.candidate',
      payload,
    },
    win.origin,
  );
}

function forwardConnectionCandidate(
  win: ObserverWindowLike,
  payload: { connected: boolean; authenticated?: boolean },
): void {
  if (!isAllowedFomoOrigin(win.origin)) {
    return;
  }

  const envelope: ConnectionCandidateEnvelope = {
    namespace: WINDOW_MESSAGE_NAMESPACE,
    protocolVersion: PROTOCOL_VERSION,
    type: 'connection.candidate',
    payload,
  };

  win.postMessage(envelope, win.origin);
}

function forwardHealthCandidate(
  win: ObserverWindowLike,
  payload: ObserverPipelineHealthEvent,
): void {
  if (!isAllowedFomoOrigin(win.origin)) {
    return;
  }

  const envelope: PipelineHealthCandidateEnvelope = {
    namespace: WINDOW_MESSAGE_NAMESPACE,
    protocolVersion: PROTOCOL_VERSION,
    type: 'pipeline.healthCandidate',
    payload,
  };
  try {
    win.postMessage(envelope, win.origin);
  } catch {
    // Telemetry is best-effort and must never affect socket observation.
  }
}
