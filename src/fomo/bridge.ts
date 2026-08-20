import { z } from 'zod';

import {
  activityCandidateEnvelopeSchema,
  connectionCandidateEnvelopeSchema,
  parseExtensionMessage,
  PROTOCOL_VERSION,
  type ExtensionMessage,
} from '../messaging/protocol';
import { isAllowedFomoOrigin } from '../messaging/guards';

/**
 * ISOLATED-world bridge for Fomo activity capture.
 *
 * installFomoBridge validates the window.postMessage envelopes posted by the
 * MAIN-world interceptor and forwards accepted candidates to the extension
 * service worker as activity.ingest messages. The Fomo activity schema is
 * deliberately NOT validated here: src/fomo/raw-schema.ts owns it and the
 * worker applies it later, so the candidate payload crosses as unknown.
 *
 * Connection state (connection.changed) carries only { connected, at } — never
 * cookies, headers, tokens, or URLs.
 *
 * The interceptor's open/close observation arrives as the shared
 * connection.candidate envelope, which lives in src/messaging/protocol.ts
 * alongside activity.candidate so producer and consumer cannot drift.
 */
export interface WindowMessageEventLike {
  source: unknown;
  data: unknown;
}

/** The subset of window the bridge relies on, injectable in unit tests. */
export interface BridgeWindowLike {
  readonly origin: string;
  addEventListener(type: 'message', listener: (event: WindowMessageEventLike) => void): void;
  addEventListener(type: 'pagehide', listener: () => void): void;
  removeEventListener(type: 'message', listener: (event: WindowMessageEventLike) => void): void;
  removeEventListener(type: 'pagehide', listener: () => void): void;
}

/** Injected sender so the bridge is testable without a real Chrome runtime. */
export type MessageSender = (message: unknown) => void;

export interface FomoBridgeOptions {
  window: BridgeWindowLike;
  sendMessage: MessageSender;
  now?: () => number;
}

export interface FomoBridge {
  uninstall(): void;
}

// payload matches the protocol's inferred envelope payload type (zod v4
// infers z.unknown().refine(...) as {} | null, i.e. any defined value).
type AcceptedWindowEvent =
  | { kind: 'activity'; payload: {} | null }
  | { kind: 'connection'; connected: boolean; authenticated: boolean | undefined };

/**
 * Local wrapper around the shared window-message guard: the shared guard in
 * src/messaging/guards.ts compares event.source against the global window,
 * which is not injectable. This mirrors its checks against the injected
 * window while reusing the exact envelope schema and the shared origin
 * catalog. Every rejection is silent: no throwing, no console noise carrying
 * payload data.
 */
function acceptWindowEvent(
  event: WindowMessageEventLike,
  win: BridgeWindowLike,
): AcceptedWindowEvent | null {
  if (event.source !== win) {
    return null;
  }

  if (!isAllowedFomoOrigin(win.origin)) {
    return null;
  }

  const activity = activityCandidateEnvelopeSchema.safeParse(event.data);

  if (activity.success) {
    return { kind: 'activity', payload: activity.data.payload };
  }

  const connection = connectionCandidateEnvelopeSchema.safeParse(event.data);

  if (connection.success) {
    return {
      kind: 'connection',
      connected: connection.data.payload.connected,
      authenticated: connection.data.payload.authenticated,
    };
  }

  return null;
}

/** Validates our own outgoing message against the protocol before sending. */
function deliver(sendMessage: MessageSender, message: ExtensionMessage): void {
  const parsed = parseExtensionMessage(message);

  if (parsed.ok) {
    sendMessage(message);
  }
}

export function installFomoBridge(options: FomoBridgeOptions): FomoBridge {
  const win = options.window;
  const sendMessage = options.sendMessage;
  const now = options.now ?? (() => Date.now());

  // Defense in depth: even if this ran on a non-Fomo page, install nowhere.
  if (!isAllowedFomoOrigin(win.origin)) {
    return { uninstall: () => {} };
  }

  // BLOCKING 2: the bridge tracks whether the authenticated socket has
  // opened on THIS page instance (the interceptor's socket-open
  // observation). Close events carry no auth claim, so the flag stays sticky
  // across reconnects; a fresh page load or pagehide resets it to false.
  let socketAuthenticated = false;

  const emitConnectionChanged = (connected: boolean, authenticated: boolean): void => {
    deliver(sendMessage, {
      protocolVersion: PROTOCOL_VERSION,
      type: 'connection.changed',
      payload: { connected, authenticated, at: now() },
    });
  };

  const onMessage = (event: WindowMessageEventLike): void => {
    const accepted = acceptWindowEvent(event, win);

    if (accepted === null) {
      return;
    }

    if (accepted.kind === 'activity') {
      deliver(sendMessage, {
        protocolVersion: PROTOCOL_VERSION,
        type: 'activity.ingest',
        payload: accepted.payload,
      });
      return;
    }

    if (accepted.authenticated === true) {
      socketAuthenticated = true;
    }

    emitConnectionChanged(
      accepted.connected,
      accepted.authenticated ?? socketAuthenticated,
    );
  };

  const onPageHide = (): void => {
    socketAuthenticated = false;
    emitConnectionChanged(false, false);
  };

  win.addEventListener('message', onMessage);
  win.addEventListener('pagehide', onPageHide);

  // BLOCKING 2: page load reports the page as PRESENT but NOT connected and
  // NOT authenticated - the old behavior claimed connected:true on load,
  // which made a freshly-opened logged-OUT page read as a live feed for the
  // stale window. Only the socket-open observation upgrades to connected.
  socketAuthenticated = false;
  emitConnectionChanged(false, false);

  return {
    uninstall(): void {
      win.removeEventListener('message', onMessage);
      win.removeEventListener('pagehide', onPageHide);
    },
  };
}
