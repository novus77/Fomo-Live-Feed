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
import { rawActivitySchema } from './raw-schema';
import type { CaptureRecoveryReason } from '../background/pipeline-health';

/**
 * ISOLATED-world bridge for Fomo activity capture.
 *
 * installFomoBridge validates the window.postMessage envelopes posted by the
 * MAIN-world interceptor and forwards accepted candidates to the extension
 * service worker as activity.ingest messages. Raw activity payloads remain
 * unknown across this boundary so the worker owns rejection handling.
 * The shared raw schema is only checked when an activity would upgrade the
 * connection state, preventing malformed candidates from disabling fallback.
 *
 * Connection state (connection.changed) carries only connection booleans and
 * a timestamp — never cookies, headers, tokens, or URLs.
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
  postMessage?(message: unknown, targetOrigin: string): void;
  addEventListener(type: 'message', listener: (event: WindowMessageEventLike) => void): void;
  addEventListener(type: 'pagehide' | 'pageshow' | 'focus', listener: (event: { persisted?: boolean }) => void): void;
  removeEventListener(type: 'message', listener: (event: WindowMessageEventLike) => void): void;
  removeEventListener(type: 'pagehide' | 'pageshow' | 'focus', listener: (event: { persisted?: boolean }) => void): void;
}

/** Injected sender so the bridge is testable without a real Chrome runtime. */
export type MessageSender = (message: unknown) => void;

export interface FomoBridgeOptions {
  window: BridgeWindowLike;
  document?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  sendMessage: MessageSender;
  now?: () => number;
}

export interface FomoBridge {
  hasAuthenticatedCapture(): boolean;
  shouldUseDomFallback(): boolean;
  reportConnection(): void;
  noteDomActivity(activity: unknown): void;
  uninstall(): void;
}

export const PRIMARY_CAPTURE_QUIET_MS = 15_000;

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
    return {
      hasAuthenticatedCapture: () => false,
      shouldUseDomFallback: () => false,
      reportConnection: () => {},
      noteDomActivity: () => {},
      uninstall: () => {},
    };
  }

  // Authentication is sticky for this page instance. It is confirmed either
  // by the authenticated socket opening or by a verified activity candidate
  // from the MAIN-world observer (WebSocket/fetch/XHR). The latter recovers
  // when injection happens after the socket's one-shot open event.
  let captureAuthenticated = false;
  let captureConnected = false;
  let primaryAvailable = false;
  let lastPrimaryAt: number | undefined;
  let lastDomAt: number | undefined;
  let lastSocketClosedAt: number | undefined;
  let fallbackReported = false;
  let active = true;
  let domEvidenceSince = now();

  const emitConnectionChanged = (connected: boolean, authenticated: boolean): void => {
    deliver(sendMessage, {
      protocolVersion: PROTOCOL_VERSION,
      type: 'connection.changed',
      payload: { connected, authenticated, at: now() },
    });
  };
  const recordRecovery = (reason: CaptureRecoveryReason): void => {
    deliver(sendMessage, {
      protocolVersion: PROTOCOL_VERSION,
      type: 'pipeline.healthEvent',
      payload: { type: 'capture.recovery', reason, at: now() },
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
      const validActivity = rawActivitySchema.safeParse(accepted.payload).success;
      if (active && validActivity) {
        primaryAvailable = true;
        lastPrimaryAt = now();
        fallbackReported = false;
      }
      if (
        active && validActivity && (!captureConnected || !captureAuthenticated)
      ) {
        captureConnected = true;
        captureAuthenticated = true;
        emitConnectionChanged(true, true);
      }

      deliver(sendMessage, {
        protocolVersion: PROTOCOL_VERSION,
        type: 'activity.ingest',
        payload: accepted.payload,
      });
      return;
    }

    if (accepted.kind === 'health') {
      if (accepted.payload.type === 'socket.closed') lastSocketClosedAt = accepted.payload.at;
      deliver(sendMessage, {
        protocolVersion: PROTOCOL_VERSION,
        type: 'pipeline.healthEvent',
        payload: accepted.payload,
      });
      return;
    }

    if (!active) return;
    if (accepted.authenticated === true) {
      captureAuthenticated = true;
    }

    captureConnected = accepted.connected || (lastDomAt !== undefined
      && now() - lastDomAt < PRIMARY_CAPTURE_QUIET_MS);
    primaryAvailable = accepted.connected;
    if (accepted.connected && lastPrimaryAt === undefined) lastPrimaryAt = now();

    emitConnectionChanged(
      captureConnected,
      accepted.authenticated ?? captureAuthenticated,
    );
  };

  const requestConnection = (): void => {
    win.postMessage?.({
      namespace: WINDOW_MESSAGE_NAMESPACE,
      protocolVersion: PROTOCOL_VERSION,
      type: 'connection.request',
    }, win.origin);
  };
  const reportConnection = (): void => {
    if (!active) return;
    emitConnectionChanged(captureConnected, captureAuthenticated);
    requestConnection();
  };
  const onPageHide = (event: { persisted?: boolean } = {}): void => {
    active = false;
    captureConnected = false;
    primaryAvailable = false;
    lastPrimaryAt = undefined;
    lastDomAt = undefined;
    domEvidenceSince = now();
    if (event.persisted !== true) captureAuthenticated = false;
    emitConnectionChanged(false, captureAuthenticated);
  };
  const onResume = (): void => {
    active = true;
    recordRecovery('page-resumed');
    reportConnection();
  };
  const onVisibilityChange = (): void => {
    if (options.document?.visibilityState === 'visible') onResume();
  };

  win.addEventListener('message', onMessage);
  win.addEventListener('pagehide', onPageHide);
  win.addEventListener('pageshow', onResume);
  win.addEventListener('focus', onResume);
  options.document?.addEventListener('visibilitychange', onVisibilityChange);

  // MAIN and ISOLATED content scripts have no installation ordering
  // guarantee. Tell the MAIN observer that the bridge is now ready so it can
  // replay its small pre-bridge buffer in order.
  win.postMessage?.({
    namespace: WINDOW_MESSAGE_NAMESPACE,
    protocolVersion: PROTOCOL_VERSION,
    type: 'bridge.ready',
  }, win.origin);

  // BLOCKING 2: page load reports the page as PRESENT but NOT connected and
  // NOT authenticated - the old behavior claimed connected:true on load,
  // which made a freshly-opened logged-OUT page read as a live feed for the
  // stale window. A socket-open event or a verified activity upgrades it.
  captureConnected = false;
  captureAuthenticated = false;
  emitConnectionChanged(false, false);

  return {
    hasAuthenticatedCapture(): boolean {
      return captureAuthenticated;
    },
    shouldUseDomFallback(): boolean {
      const fallback = active && (!primaryAvailable || lastPrimaryAt === undefined
        || now() - lastPrimaryAt >= PRIMARY_CAPTURE_QUIET_MS);
      if (fallback && captureAuthenticated && !fallbackReported) {
        fallbackReported = true;
        recordRecovery(!primaryAvailable && lastSocketClosedAt !== undefined
          && lastSocketClosedAt >= (lastPrimaryAt ?? 0) ? 'socket-closed' : 'primary-quiet');
      }
      return fallback;
    },
    reportConnection,
    noteDomActivity(activity: unknown): void {
      if (!active) return;
      const parsed = rawActivitySchema.safeParse(activity);
      if (!parsed.success) return;
      const occurredAt = Date.parse(parsed.data.createdAt);
      // Existing historical cards are not evidence that capture is live.
      if (occurredAt < Math.max(domEvidenceSince, now() - PRIMARY_CAPTURE_QUIET_MS)
        || occurredAt > now() + 5_000) return;
      lastDomAt = now();
      if (captureConnected && captureAuthenticated) return;
      captureConnected = true;
      captureAuthenticated = true;
      emitConnectionChanged(true, true);
    },
    uninstall(): void {
      active = false;
      win.removeEventListener('message', onMessage);
      win.removeEventListener('pagehide', onPageHide);
      win.removeEventListener('pageshow', onResume);
      win.removeEventListener('focus', onResume);
      options.document?.removeEventListener('visibilitychange', onVisibilityChange);
    },
  };
}
