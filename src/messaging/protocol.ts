import { z } from 'zod';

import {
  DIAGNOSTIC_CODES,
  MAX_MESSAGE_TYPE_LENGTH,
  MAX_MISSING_FIELDS,
  MAX_SCHEMA_VERSION,
} from '../background/diagnostics';
import type { ChainKey } from '../domain/activity';

// Transport protocol shared by every cross-context message boundary in the
// extension (content bridge -> worker, worker -> popup). Version is a literal
// 1: any future breaking change must bump it and branch on the result of
// parseExtensionMessage before touching the discriminant.
export const PROTOCOL_VERSION = 1 as const;

export type ProtocolVersion = typeof PROTOCOL_VERSION;

// Namespace for the MAIN-world -> content window.postMessage envelope used by
// the Fomo interceptor. Exported so the interceptor and the bridge validation
// can never drift apart.
export const WINDOW_MESSAGE_NAMESPACE = 'fomo-live-feed';

export const MAX_QUERY_LIMIT = 100;
const MAX_CURSOR_ID_LENGTH = 512;
const MAX_SEARCH_LENGTH = 100;
const MAX_TRADER_ID_LENGTH = 128;
const MAX_TOKEN_ADDRESS_LENGTH = 256;
const MAX_MARK_READ_IDS = 1_000;
const MAX_MARK_READ_ID_LENGTH = 512;

const CHAIN_KEYS = [
  'solana',
  'ethereum',
  'bsc',
  'base',
  'monad',
  'unknown',
] as const satisfies readonly ChainKey[];

const trimmedBoundedString = (maxLength: number) =>
  z.string().trim().min(1).max(maxLength);

const timestampSchema = z.number().int().nonnegative();

// The popup -> worker query contract.
//
// EventQuery is the TRANSPORT-level query: it crosses the popup -> worker
// boundary and is validated here. It is NOT a 1:1 mirror of EventPageQuery in
// src/storage/event-repository.ts. The storage-layer query intentionally
// implements only the predicates the Dexie indexes can execute (cursor
// beforeOccurredAt/beforeId, traderId, chain, tokenAddress, unreadOnly, and
// limit); it deliberately has no free-text search field.
//
// `search` is therefore a popup-side, post-filter concern: the popup fetches
// bounded pages through EventPageQuery and applies the text filter in memory,
// matching trader handle/name, token symbol, and full contract address from
// the returned event rows, and ANNOTATION LABELS against chrome.storage.local
// (labels live in chrome.storage.local and are unreachable from any Dexie
// index). Task 9 must not assume the database can execute `search`; the
// field is only trimmed and bounded here, then applied by the popup.
export const eventQuerySchema = z
  .object({
    limit: z.number().int().min(1).max(MAX_QUERY_LIMIT),
    beforeOccurredAt: timestampSchema.optional(),
    beforeId: trimmedBoundedString(MAX_CURSOR_ID_LENGTH).optional(),
    traderId: trimmedBoundedString(MAX_TRADER_ID_LENGTH).optional(),
    chain: z.enum(CHAIN_KEYS).optional(),
    tokenAddress: trimmedBoundedString(MAX_TOKEN_ADDRESS_LENGTH).optional(),
    unreadOnly: z.boolean().optional(),
    // Transport-level text filter, applied post-page by the popup (see the
    // comment above); the storage layer never receives or executes it.
    search: trimmedBoundedString(MAX_SEARCH_LENGTH).optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.beforeId !== undefined && query.beforeOccurredAt === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'beforeId requires beforeOccurredAt',
        path: ['beforeId'],
      });
    }
  });

export type EventQuery = z.infer<typeof eventQuerySchema>;

// BLOCKING 2: connection.changed now carries an explicit authenticated
// flag derived from the MAIN-world interceptor observing the authenticated
// Fomo WebSocket OPEN (an unauthenticated page cannot open it). This is the
// honest auth signal the popup needs for login-required, and it never touches
// cookies, headers, or tokens (spec section 9). `connected` is the socket's
// explicit open/closed state - an idle-but-open socket stays connected, and
// only socket close / page presence / pagehide move it.
const connectionChangedPayloadSchema = z
  .object({
    connected: z.boolean(),
    authenticated: z.boolean(),
    at: timestampSchema,
  })
  .strict();

const markReadPayloadSchema = z
  .object({
    ids: z.array(trimmedBoundedString(MAX_MARK_READ_ID_LENGTH)).max(MAX_MARK_READ_IDS),
    at: timestampSchema,
  })
  .strict();

// Popup -> worker redacted schema-rejection diagnostic (BLOCKING 3). The
// popup drops malformed event rows it cannot render and asks the worker to
// record ONE bounded diagnostic per affected query; the worker's
// DiagnosticRecorder ring buffer caps storage and re-sanitizes every field.
// The payload carries only the closed code set and field NAMES - never raw
// rows, cookies, headers, or URLs.
const diagnosticRecordPayloadSchema = z
  .object({
    code: z.enum(DIAGNOSTIC_CODES),
    schemaVersion: z.number().int().nonnegative().max(MAX_SCHEMA_VERSION).optional(),
    messageType: trimmedBoundedString(MAX_MESSAGE_TYPE_LENGTH).optional(),
    missingFields: z
      .array(trimmedBoundedString(MAX_MESSAGE_TYPE_LENGTH))
      .max(MAX_MISSING_FIELDS)
      .optional(),
  })
  .strict();

// activity.ingest.payload deliberately stays unknown at this layer.
// src/fomo/raw-schema.ts owns the Fomo activity schema; this module must not
// import or duplicate it.
const unknownPayloadSchema = z.unknown().refine(
  (value) => value !== undefined,
  { message: 'payload must not be undefined' },
);

// Strict worker -> overlay broadcast payload. `event` stays UNKNOWN at this
// transport layer on purpose: the overlay re-validates the event field by
// field (defense in depth in src/overlay/trading-overlay.ts) before any card
// is pushed. `toast` is the worker suppression verdict (muted trader,
// muted chain, minimumUsdAmount); false means the overlay keeps history but
// shows no card.
const activityBroadcastPayloadSchema = z
  .object({
    event: unknownPayloadSchema,
    toast: z.boolean(),
  })
  .strict();

// Versioned, discriminated message union for every extension context. Keep the
// branch list in KNOWN_MESSAGE_TYPES in sync with this union.
export const extensionMessageSchema = z.discriminatedUnion('type', [
  z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      type: z.literal('activity.ingest'),
      payload: unknownPayloadSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      type: z.literal('activity.broadcast'),
      payload: activityBroadcastPayloadSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      type: z.literal('connection.changed'),
      payload: connectionChangedPayloadSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      type: z.literal('events.query'),
      payload: eventQuerySchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      type: z.literal('events.markRead'),
      payload: markReadPayloadSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      type: z.literal('preferences.changed'),
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      type: z.literal('diagnostics.record'),
      payload: diagnosticRecordPayloadSchema,
    })
    .strict(),
  z
    .object({
      protocolVersion: z.literal(PROTOCOL_VERSION),
      type: z.literal('connection.query'),
    })
    .strict(),
]);

export type ExtensionMessage = z.infer<typeof extensionMessageSchema>;

/**
 * Worker -> popup reply for connection.query (plan Task 9 Step 3, BLOCKING 2).
 *
 * The popup derives its top-level states from this one response:
 * - connected: at least one tracked Fomo tab's authenticated socket is
 *   currently OPEN (explicit open/close tracking - an idle-but-open socket
 *   stays connected, however quiet);
 * - authenticated: an authenticated socket has been observed open on some
 *   Fomo tab (the interceptor's socket-open observation; an unauthenticated
 *   page cannot open the authenticated socket);
 * - hasFomoTab: tabs.query found a Fomo tab.
 *
 * connected+authenticated drive the connected / reconnecting /
 * login-required / offline split in src/popup/event-query.ts. There is no
 * activity-age heuristic anywhere in this contract.
 */
export interface ConnectionQueryResponse {
  ok: true;
  connected: boolean;
  authenticated: boolean;
  hasFomoTab: boolean;
}

/**
 * Worker -> overlay broadcast envelope (BLOCKING 1 protocol drift fix).
 *
 * The worker broadcasts exactly this shape after a new event is inserted; the
 * overlay validates it with parseExtensionMessage and re-validates
 * payload.event field by field before pushing a card. The toast flag carries
 * the worker's suppression verdict (muted trader/chain, minimumUsdAmount).
 */
export type ActivityBroadcastMessage = Extract<
  ExtensionMessage,
  { type: 'activity.broadcast' }
>;

// MAIN-world -> content envelope. The interceptor posts exactly this shape and
// the bridge accepts only this shape, so both sides reference the same
// constants and schema.
export const activityCandidateEnvelopeSchema = z
  .object({
    namespace: z.literal(WINDOW_MESSAGE_NAMESPACE),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    type: z.literal('activity.candidate'),
    payload: unknownPayloadSchema,
  })
  .strict();

export type ActivityCandidateEnvelope = z.infer<typeof activityCandidateEnvelopeSchema>;

/**
 * MAIN-world -> content envelope for socket liveness.
 *
 * The isolated bridge cannot observe the page's own WebSocket, so the
 * interceptor relays open/close here. `authenticated` is present only on the
 * socket-open observation: an unauthenticated page cannot open the
 * authenticated Fomo socket, so "socket opened" is an honest auth signal that
 * never touches cookies, headers, or tokens (design spec section 9).
 *
 * This lives beside the activity envelope so the interceptor and the bridge
 * reference one definition instead of two literals that can drift apart.
 */
export const connectionCandidateEnvelopeSchema = z
  .object({
    namespace: z.literal(WINDOW_MESSAGE_NAMESPACE),
    protocolVersion: z.literal(PROTOCOL_VERSION),
    type: z.literal('connection.candidate'),
    payload: z
      .object({
        connected: z.boolean(),
        authenticated: z.boolean().optional(),
      })
      .strict(),
  })
  .strict();

export type ConnectionCandidateEnvelope = z.infer<
  typeof connectionCandidateEnvelopeSchema
>;

export type ProtocolRejectionCode =
  | 'not-object'
  | 'missing-protocol-version'
  | 'unsupported-protocol-version'
  | 'missing-type'
  | 'unknown-type'
  | 'invalid-payload';

export type ProtocolParseResult =
  | { ok: true; message: ExtensionMessage }
  | { ok: false; reason: ProtocolRejectionCode };

const KNOWN_MESSAGE_TYPES = [
  'activity.ingest',
  'activity.broadcast',
  'connection.changed',
  'connection.query',
  'diagnostics.record',
  'events.query',
  'events.markRead',
  'preferences.changed',
] as const satisfies readonly ExtensionMessage['type'][];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isKnownMessageType = (type: string): boolean =>
  KNOWN_MESSAGE_TYPES.some((known) => known === type);

// Validates the envelope with Zod before any branching on the discriminant.
// Never throws for untrusted input and never echoes the rejected payload: the
// reason is always one of a small closed set of codes.
export function parseExtensionMessage(input: unknown): ProtocolParseResult {
  const result = extensionMessageSchema.safeParse(input);

  if (result.success) {
    return { ok: true, message: result.data };
  }

  return { ok: false, reason: classifyProtocolRejection(input) };
}

function classifyProtocolRejection(input: unknown): ProtocolRejectionCode {
  if (!isRecord(input)) {
    return 'not-object';
  }

  if (!('protocolVersion' in input)) {
    return 'missing-protocol-version';
  }

  if (input.protocolVersion !== PROTOCOL_VERSION) {
    return 'unsupported-protocol-version';
  }

  if (typeof input.type !== 'string' || input.type.length === 0) {
    return 'missing-type';
  }

  if (!isKnownMessageType(input.type)) {
    return 'unknown-type';
  }

  return 'invalid-payload';
}
