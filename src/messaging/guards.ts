import { activityCandidateEnvelopeSchema } from './protocol';

// Single source of truth for every allowed Fomo origin. Both guards below
// compare against this exact catalog, so hosts are declared in exactly one
// place. Only HTTPS origins are permitted.
export const FOMO_ORIGINS = [
  'https://fomo.family',
  'https://www.fomo.family',
] as const;

export type FomoOrigin = (typeof FOMO_ORIGINS)[number];

export function isAllowedFomoOrigin(origin: string): origin is FomoOrigin {
  return FOMO_ORIGINS.some((allowed) => allowed === origin);
}

// The subset of chrome.runtime.MessageSender this guard relies on, so unit
// tests need no real Chrome runtime. Content-script senders carry a `tab`;
// the extension's own popup/UI pages carry an `id` and optionally a `url` but
// never a `tab`.
export interface MessageSenderLike {
  id?: string;
  url?: string;
  tab?: {
    url?: string;
  };
}

/**
 * True only when the URL is a real HTTPS document on an allowed Fomo origin.
 *
 * The protocol check matters: `new URL('blob:https://fomo.family/abc').origin`
 * is `https://fomo.family`, so an origin check alone lets a `blob:` or
 * `filesystem:` document impersonate a trusted Fomo sender. Requiring
 * `protocol === 'https:'` in addition to the exact-origin match rejects every
 * non-https scheme, including blob:, filesystem:, data:, and javascript:.
 */
function isTrustedHttpsUrl(url: URL): boolean {
  return url.protocol === 'https:' && isAllowedFomoOrigin(url.origin);
}

/**
 * True only when the sender is a content script running in a real Fomo tab.
 *
 * Accepts a MessageSender-shaped object and returns true only when the tab URL
 * parses, uses the https: protocol, and its origin is EXACTLY one of the
 * allowed Fomo origins. Rejects missing senders/tabs/urls, unparseable URLs,
 * http:, non-https schemes (blob:, filesystem:, ...), different hosts,
 * subdomain look-alikes, userinfo tricks, and non-default ports. When
 * expectedExtensionId is supplied, sender.id must match it, rejecting messages
 * claimed to come from other extensions.
 *
 * This guard NEVER accepts the extension's own popup: a popup sender has no
 * tab, so it is rejected here and must be vetted by isTrustedPopupSender.
 */
export function isTrustedFomoSender(
  sender: MessageSenderLike | null | undefined,
  expectedExtensionId?: string,
): boolean {
  if (sender === null || sender === undefined) {
    return false;
  }

  if (expectedExtensionId !== undefined && sender.id !== expectedExtensionId) {
    return false;
  }

  const tabUrl = sender.tab?.url;

  if (typeof tabUrl !== 'string') {
    return false;
  }

  let url: URL;

  try {
    url = new URL(tabUrl);
  } catch {
    return false;
  }

  return isTrustedHttpsUrl(url);
}

/**
 * True only when the sender is one of THIS extension's own privileged UI
 * pages (the toolbar popup, for example).
 *
 * A popup sender has no `tab`, its `id` is our own extension id, and its
 * `url` (when present) must be a `chrome-extension://<our-id>/...` page.
 * Every check is required:
 *
 * - `sender.tab` must be absent, so a content script (which always carries a
 *   tab) can never satisfy this guard.
 * - `sender.id` must equal expectedExtensionId, so another extension cannot
 *   impersonate us.
 * - A present `sender.url` must parse to our own chrome-extension page; a
 *   missing url is accepted because Chrome popup senders do not always carry
 *   one, but any url that is present is verified.
 */
export function isTrustedPopupSender(
  sender: MessageSenderLike | null | undefined,
  expectedExtensionId: string,
): boolean {
  if (sender === null || sender === undefined) {
    return false;
  }

  if (sender.id !== expectedExtensionId) {
    return false;
  }

  if (sender.tab !== undefined) {
    return false;
  }

  if (sender.url === undefined) {
    return true;
  }

  let url: URL;

  try {
    url = new URL(sender.url);
  } catch {
    return false;
  }

  return url.protocol === 'chrome-extension:' && url.host === expectedExtensionId;
}

/**
 * Which trust class a protocol message type requires.
 *
 * `activity.ingest` and `connection.changed` come from the Fomo content
 * bridge, so they require a real Fomo content-script tab. `events.query`,
 * `events.markRead`, and `preferences.changed` are initiated by the toolbar
 * popup, so they require our own privileged UI page. Task 7 must route every
 * incoming message through this helper (via isTrustedSenderForMessage) so a
 * popup message can never be accepted from a web tab and vice versa.
 *
 * `activity.broadcast` is a worker-originated notification. It originates
 * from OUR OWN service worker, never from a Fomo tab and never from the
 * popup, and it is OUTBOUND ONLY: the worker broadcasts it with
 * tabs.sendMessage and must never ACCEPT it inbound. Assigning it either
 * existing trust class would let that class's senders inject broadcasts into
 * the worker, so the coherent mapping is NO inbound sender class: the
 * worker's gate (isTrustedSenderForMessage) rejects any inbound
 * activity.broadcast outright. Side Panel listeners validate runtime messages
 * through the shared protocol parser before refreshing persisted history.
 */
export type SenderTrustClass = 'fomo-content-script' | 'privileged-ui-page';

export function trustClassForMessageType(
  messageType: string,
): SenderTrustClass | null {
  switch (messageType) {
    case 'activity.ingest':
    case 'connection.changed':
    case 'pipeline.healthEvent':
    case 'translation.ready':
    case 'translation.hostReady':
      return 'fomo-content-script';
    case 'events.query':
    case 'events.markRead':
    case 'preferences.changed':
    case 'connection.query':
    case 'diagnostics.record':
    case 'pipeline.healthQuery':
    case 'sync.request':
    case 'sync.query':
    case 'translation.request':
      return 'privileged-ui-page';
    case 'activity.broadcast':
    case 'events.changed':
    case 'pipeline.healthChanged':
    case 'sync.changed':
      // Outbound-only worker -> overlay message: no inbound sender class is
      // valid, so the worker rejects any inbound broadcast (see docstring).
      return null;
    default:
      return null;
  }
}

/**
 * Single entry point for sender validation: maps the message type to its
 * required trust class and applies the matching guard. Unknown message types
 * are rejected outright.
 */
export function isTrustedSenderForMessage(
  sender: MessageSenderLike | null | undefined,
  messageType: string,
  expectedExtensionId: string,
): boolean {
  const trustClass = trustClassForMessageType(messageType);

  if (trustClass === null) {
    return false;
  }

  if (trustClass === 'fomo-content-script') {
    return isTrustedFomoSender(sender, expectedExtensionId);
  }

  return isTrustedPopupSender(sender, expectedExtensionId);
}

// The subset of a window.message event this guard relies on.
export interface WindowMessageEventLike {
  source: unknown;
  data: unknown;
}

// Accepts the interceptor envelope only when it was posted by this window
// itself, the page origin is an allowed Fomo origin, and the envelope passes
// strict validation (exact namespace, protocol version 1, type
// activity.candidate, defined payload, no extra fields). windowOrigin defaults
// to the real page origin but is injectable for tests.
export function isTrustedFomoWindowMessage(
  event: WindowMessageEventLike,
  windowOrigin: string = window.location.origin,
): boolean {
  if (event.source !== window) {
    return false;
  }

  if (!isAllowedFomoOrigin(windowOrigin)) {
    return false;
  }

  return activityCandidateEnvelopeSchema.safeParse(event.data).success;
}
