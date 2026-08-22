import {
  PROTOCOL_VERSION,
  WINDOW_MESSAGE_NAMESPACE,
  type ConnectionCandidateEnvelope,
  type PipelineHealthCandidateEnvelope,
  type ObserverPipelineHealthEvent,
} from '../messaging/protocol';
import { isAllowedFomoOrigin } from '../messaging/guards';

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
      observeSocket(socket, win, now);
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

function observeSocket(
  socket: WebSocketLike,
  win: ObserverWindowLike,
  now?: () => number,
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
      forwardConnectionCandidate(win, { connected: false });
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

  if (record.type !== 'data' || record.topicType !== 'trading_activity') {
    return undefined;
  }

  return record.payload;
}

function forwardActivityCandidate(win: ObserverWindowLike, payload: unknown): void {
  if (!isAllowedFomoOrigin(win.origin)) {
    return;
  }

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
