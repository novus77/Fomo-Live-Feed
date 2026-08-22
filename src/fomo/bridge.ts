import { z } from 'zod';

import {
  activityCandidateEnvelopeSchema,
  connectionCandidateEnvelopeSchema,
  pipelineHealthCandidateEnvelopeSchema,
  parseExtensionMessage,
  PROTOCOL_VERSION,
  WINDOW_MESSAGE_NAMESPACE,
  type ExtensionMessage,
  type RejectionStageHealthEvent,
} from '../messaging/protocol';
import { isAllowedFomoOrigin } from '../messaging/guards';
import type { ObserverPipelineHealthEvent } from '../messaging/protocol';

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
  | { kind: 'connection'; connected: boolean; authenticated: boolean | undefined }
  | { kind: 'health'; payload: ObserverPipelineHealthEvent };

/**
 * Outcome of validating one window message. `envelope-rejected` means the
 * message came from this window, on an allowed origin, and claims the Fomo
 * namespace but failed every closed envelope schema — evidence that the
 * interceptor's envelope shape drifted (plan Task 2). Anything else the page
 * posts is `ignored` silently.
 */
type WindowEventAcceptance =
  | { kind: 'accepted'; value: AcceptedWindowEvent }
  | { kind: 'ignored' }
  | { kind: 'envelope-rejected' };

/**
 * True only for messages that reference the Fomo window-message namespace.
 * Generic page messages never count as envelope rejections, so the bounded
 * bridge-envelope counter is precise drift evidence, not page noise.
 */
function isFomoNamespacedEnvelope(data: unknown): boolean {
  return (
    typeof data === 'object' &&
    data !== null &&
    !Array.isArray(data) &&
    (data as Record<string, unknown>).namespace === WINDOW_MESSAGE_NAMESPACE
  );
}

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
): WindowEventAcceptance {
  if (event.source !== win) {
    return { kind: 'ignored' };
  }

  if (!isAllowedFomoOrigin(win.origin)) {
    return { kind: 'ignored' };
  }

  const activity = activityCandidateEnvelopeSchema.safeParse(event.data);

  if (activity.success) {
    return { kind: 'accepted', value: { kind: 'activity', payload: activity.data.payload } };
  }

  const connection = connectionCandidateEnvelopeSchema.safeParse(event.data);

  if (connection.success) {
    return {
      kind: 'accepted',
      value: {
        kind: 'connection',
        connected: connection.data.payload.connected,
        authenticated: connection.data.payload.authenticated,
      },
    };
  }

  const health = pipelineHealthCandidateEnvelopeSchema.safeParse(event.data);
  if (health.success) {
    return { kind: 'accepted', value: { kind: 'health', payload: health.data.payload } };
  }

  return isFomoNamespacedEnvelope(event.data)
    ? { kind: 'envelope-rejected' }
    : { kind: 'ignored' };
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
    const acceptance = acceptWindowEvent(event, win);

    if (acceptance.kind === 'ignored') {
      return;
    }

    if (acceptance.kind === 'envelope-rejected') {
      // Bounded bridge-envelope evidence (plan Task 2): only the closed stage
      // code and a timestamp cross the boundary; the raw candidate, its
      // payload, and any smuggled fields never do.
      const payload: RejectionStageHealthEvent = {
        type: 'activity.rejectionStage',
        stage: 'bridge-envelope',
        at: now(),
      };

      deliver(sendMessage, {
        protocolVersion: PROTOCOL_VERSION,
        type: 'pipeline.healthEvent',
        payload,
      });
      return;
    }

    const accepted = acceptance.value;

    if (accepted.kind === 'activity') {
      deliver(sendMessage, {
        protocolVersion: PROTOCOL_VERSION,
        type: 'activity.ingest',
        payload: accepted.payload,
      });
      return;
    }

    if (accepted.kind === 'health') {
      deliver(sendMessage, {
        protocolVersion: PROTOCOL_VERSION,
        type: 'pipeline.healthEvent',
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
