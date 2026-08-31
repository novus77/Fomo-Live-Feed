/**
 * Bounded, redacted diagnostics for the background worker.
 *
 * The recorder keeps an in-memory ring buffer of at most
 * MAX_DIAGNOSTIC_RECORDS entries, evicting the oldest first. Every record is
 * stamped with an injected clock (never Date.now()) so tests control time.
 *
 * Redaction is the point of this module: the public API accepts only a closed
 * set of codes, an allowlisted message type shape, and field NAMES. Raw
 * payloads, cookies, headers, comments, wallet balances, addresses, and
 * arbitrary URLs can never reach storage — hostile keys that are not known
 * field names are dropped before a record is created.
 *
 * The module also owns the CLOSED evidence model for missing live activities
 * (plan Task 2): the seven rejection stages an activity can be lost at, and
 * the bounded per-network aggregate for network IDs the catalog does not
 * know. Both shapes record ONLY closed stage codes, numeric IDs, counters,
 * and timestamps — identity, address, amount, opinion, URL, and raw-payload
 * values cannot be expressed, so their schemas reject them outright.
 */

import { z } from 'zod';

export const DIAGNOSTIC_CODES = [
  'schema_rejection',
  'enrichment_failure',
  'storage_failure',
  'bridge_disconnected',
  'provisional_network_mapping',
  'audio_playback_failure',
  'token_navigation_failure',
] as const;

export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];

export const MAX_DIAGNOSTIC_RECORDS = 100;
export const MAX_MISSING_FIELDS = 8;

// Diagnostic records carry the schema version of the payload that failed;
// versions beyond this plausibility cap are dropped rather than persisted.
export const MAX_SCHEMA_VERSION = 100;

export const MAX_MESSAGE_TYPE_LENGTH = 64;
const MESSAGE_TYPE_PATTERN = /^[a-z][a-z0-9._-]*$/;

/**
 * The closed set of pipeline stages where a live activity can be lost
 * (plan Task 2). Each stage records a bounded counter and a timestamp — never
 * the raw candidate. `observer-topic` and `bridge-envelope` are the
 * capture-side boundaries; the rest are worker-side ingest stages.
 */
export const ACTIVITY_REJECTION_STAGES = [
  'observer-topic',
  'bridge-envelope',
  'raw-schema',
  'normalization',
  'deduplication',
  'storage',
  'broadcast',
] as const;

export type ActivityRejectionStage = (typeof ACTIVITY_REJECTION_STAGES)[number];

export const activityRejectionStageSchema = z.enum(ACTIVITY_REJECTION_STAGES);

/**
 * Bounded evidence for a network ID the catalog does not know. Only the
 * numeric ID, a saturating counter, and the last-seen timestamp are recorded;
 * the closed shape has no field that could carry identity, address, amount,
 * opinion, URL, or raw-payload data.
 */
export interface UnknownNetworkAggregate {
  networkId: number;
  count: number;
  lastSeenAt: number;
}

/**
 * Upper bound on distinct unknown network IDs kept in the aggregate. When the
 * cap is reached, the least-recently-seen ID is evicted.
 */
export const UNKNOWN_NETWORK_AGGREGATE_LIMIT = 20;

const timestampSchema = z.number().int().nonnegative().finite();
const counterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const unknownNetworkAggregateSchema: z.ZodType<UnknownNetworkAggregate> = z
  .object({
    networkId: z.number().int().nonnegative(),
    count: counterSchema,
    lastSeenAt: timestampSchema,
  })
  .strict();

/**
 * Cross-boundary health event carrying a closed rejection stage (plan Task 2).
 * Lives here so the producer (src/fomo/bridge.ts) and the consumer
 * (src/background/pipeline-health.ts, src/messaging/protocol.ts) share one
 * definition and cannot drift. The stage is the only evidence: no raw
 * candidate, identity, address, amount, opinion, or URL field exists.
 */
export const activityRejectionStageEventSchema = z
  .object({
    type: z.literal('activity.rejectionStage'),
    stage: activityRejectionStageSchema,
    at: timestampSchema,
  })
  .strict();

export type ActivityRejectionStageEvent = z.infer<
  typeof activityRejectionStageEventSchema
>;

/**
 * Known raw-activity and envelope field names. missingFields is filtered
 * against this allowlist so a hostile payload's keys cannot be echoed into
 * storage; only these names may ever be recorded.
 */
export const KNOWN_FIELD_NAMES = [
  'action',
  'chain',
  'comment',
  'createdAt',
  'displayName',
  'id',
  'marketCap',
  'messageType',
  'networkId',
  'price',
  'profilePictureLink',
  'protocolVersion',
  'readAt',
  'receivedAt',
  'schemaVersion',
  'source',
  'sourceEventId',
  'sourceTradeId',
  'ticker',
  'tokenAddress',
  'tokenImageUrl',
  'tokenSymbol',
  'topic',
  'topicType',
  'tradeId',
  'traderAvatarUrl',
  'traderHandle',
  'traderId',
  'traderName',
  'type',
  'userId',
  'userHandle',
  'usdAmount',
] as const;

export type KnownFieldName = (typeof KNOWN_FIELD_NAMES)[number];

const KNOWN_CODES: ReadonlySet<string> = new Set(DIAGNOSTIC_CODES);
const KNOWN_FIELD_NAME_SET: ReadonlySet<string> = new Set(KNOWN_FIELD_NAMES);

export interface DiagnosticRecord {
  code: DiagnosticCode;
  receivedAt: number;
  /** Schema version of the rejected payload when known (spec section 8). */
  schemaVersion?: number;
  messageType?: string;
  missingFields?: readonly string[];
}

export interface RecordDiagnosticInput {
  code: DiagnosticCode;
  schemaVersion?: number;
  messageType?: string;
  missingFields?: readonly string[];
}

export interface DiagnosticRecorderOptions {
  now: () => number;
  capacity?: number;
  maxMissingFields?: number;
}

const isFiniteNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isKnownCode = (value: unknown): value is DiagnosticCode =>
  typeof value === 'string' && KNOWN_CODES.has(value);

/**
 * Keeps only well-formed message type names. Anything else — including URLs,
 * whitespace, or oversized strings — is dropped rather than persisted.
 */
function sanitizeMessageType(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }

  if (value.length > MAX_MESSAGE_TYPE_LENGTH) {
    return undefined;
  }

  return MESSAGE_TYPE_PATTERN.test(value) ? value : undefined;
}

/**
 * Keeps only plausible schema versions: a bounded non-negative integer.
 * Anything else — including strings, negatives, fractions, and values above
 * MAX_SCHEMA_VERSION — is dropped rather than persisted.
 */
function sanitizeSchemaVersion(value: unknown): number | undefined {
  if (!isFiniteNonNegativeInteger(value)) {
    return undefined;
  }

  if (value > MAX_SCHEMA_VERSION) {
    return undefined;
  }

  return value;
}

/**
 * Filters candidate field names against the allowlist, de-duplicates them,
 * preserves input order, and caps the count at maxMissingFields. Unknown
 * names, non-strings, and secret values are dropped.
 */
function sanitizeMissingFields(
  value: unknown,
  maxMissingFields: number,
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of value) {
    if (result.length >= maxMissingFields) {
      break;
    }

    if (typeof entry !== 'string' || !KNOWN_FIELD_NAME_SET.has(entry)) {
      continue;
    }

    if (seen.has(entry)) {
      continue;
    }

    seen.add(entry);
    result.push(entry);
  }

  return result;
}

export class DiagnosticRecorder {
  private readonly clock: () => number;
  private readonly capacity: number;
  private readonly maxMissingFields: number;
  private readonly records: DiagnosticRecord[] = [];

  constructor(options: DiagnosticRecorderOptions) {
    const capacity = options.capacity ?? MAX_DIAGNOSTIC_RECORDS;
    const maxMissingFields = options.maxMissingFields ?? MAX_MISSING_FIELDS;

    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new TypeError('capacity must be a positive integer');
    }

    if (!Number.isInteger(maxMissingFields) || maxMissingFields <= 0) {
      throw new TypeError('maxMissingFields must be a positive integer');
    }

    this.clock = options.now;
    this.capacity = Math.min(capacity, MAX_DIAGNOSTIC_RECORDS);
    this.maxMissingFields = maxMissingFields;
  }

  record(input: RecordDiagnosticInput): void {
    if (!isKnownCode(input.code)) {
      throw new TypeError(`unknown diagnostic code: ${String(input.code)}`);
    }

    const receivedAt = this.clock();

    if (!isFiniteNonNegativeInteger(receivedAt)) {
      throw new TypeError(
        'diagnostic clock must return a finite non-negative integer',
      );
    }

    const schemaVersion = sanitizeSchemaVersion(input.schemaVersion);
    const messageType = sanitizeMessageType(input.messageType);
    const missingFields = sanitizeMissingFields(
      input.missingFields,
      this.maxMissingFields,
    );

    this.records.push({
      code: input.code,
      receivedAt,
      ...(schemaVersion !== undefined ? { schemaVersion } : {}),
      ...(messageType !== undefined ? { messageType } : {}),
      ...(missingFields.length > 0 ? { missingFields } : {}),
    });

    if (this.records.length > this.capacity) {
      this.records.shift();
    }
  }

  /**
   * Returns a defensive copy of the ring buffer, oldest first. Mutating the
   * returned array, records, or missingFields lists cannot affect internal
   * state.
   */
  snapshot(): readonly DiagnosticRecord[] {
    return this.records.map((record) => ({
      code: record.code,
      receivedAt: record.receivedAt,
      ...(record.schemaVersion !== undefined
        ? { schemaVersion: record.schemaVersion }
        : {}),
      ...(record.messageType !== undefined ? { messageType: record.messageType } : {}),
      ...(record.missingFields !== undefined
        ? { missingFields: [...record.missingFields] }
        : {}),
    }));
  }
}
