import { z } from 'zod';

import { rawActivitySchema } from './raw-schema';

/**
 * Authenticated history-list contract (recovery plan Task 4).
 *
 * Parser for `GET https://prod-api.fomo.family/v2/activities/me?cursor=&limit=`
 * as documented in docs/evidence/fomo-history-contract.md. THAT DOCUMENT IS
 * PROVISIONAL-UNVERIFIED: no live authenticated capture exists, so every
 * field here is a synthetic reconstruction. This module must not be promoted
 * to production behavior until the evidence doc is re-verified from a real
 * redacted capture.
 *
 * The parser validates the response envelope (responseObject.activities,
 * responseObject.nextCursor, responseObject.hasMore), the cursor bounds
 * (≤ 512 characters), the page-size bounds (1–200), and EVERY activity
 * payload against the shared raw activity schema (src/fomo/raw-schema.ts) —
 * the same schema the live WebSocket frames cross, so recovered items feed
 * the identical normalizeActivity path. The parsed page carries only
 * activities, the next cursor, and a terminal flag: arbitrary URLs, headers,
 * or auth data never survive the parse.
 */

/** Fixed HTTPS origin for the history endpoint (contract: prod-api.fomo.family). */
export const FOMO_HISTORY_BASE_URL = 'https://prod-api.fomo.family';

/** Fixed HTTPS origin + path for the authenticated activity list. */
export const FOMO_HISTORY_ENDPOINT = FOMO_HISTORY_BASE_URL + '/v2/activities/me';

/** Page-size bounds (contract: limit 1–200, default 50). */
export const MIN_HISTORY_LIMIT = 1;
export const MAX_HISTORY_LIMIT = 200;
export const DEFAULT_HISTORY_LIMIT = 50;

/** Opaque pagination token bound (contract: ≤ 512 chars). */
export const MAX_HISTORY_CURSOR_LENGTH = 512;

/** Activities per response page (contract: at most 200). */
export const MAX_HISTORY_PAGE_SIZE = 200;

/**
 * Request-parameter validation. `cursor` may be omitted OR empty on the
 * first page and is otherwise an opaque token bounded to 512 characters (it
 * is deliberately NOT trimmed — a cursor is opaque, and trimming could
 * corrupt it). `limit` is an integer in [1, 200] and defaults to 50 when
 * omitted.
 */
export const historyQuerySchema = z
  .object({
    cursor: z.string().max(MAX_HISTORY_CURSOR_LENGTH).optional(),
    limit: z.number().int().min(MIN_HISTORY_LIMIT).max(MAX_HISTORY_LIMIT).optional(),
  })
  .strict();

export type HistoryQuery = z.infer<typeof historyQuerySchema>;

/**
 * Response cursor: a non-empty string (after trimming) bounded to 512
 * characters, or null when the page is terminal. An empty response cursor is
 * malformed — a next-page cursor that says "more" must carry a token.
 */
const responseCursorSchema = z.string().trim().min(1).max(MAX_HISTORY_CURSOR_LENGTH);

/**
 * Response-envelope schema. `responseObject` is STRICT (hostile extra keys —
 * cookies, headers, raw payloads — are rejected), while the outer body
 * tolerates unknown top-level keys such as the fixture's `note` and
 * `captureIntegrity` annotations; the parsed RESULT never carries them.
 * Every activity payload is validated against the shared raw activity schema
 * so a malformed row fails the whole page instead of surfacing later.
 */
export const historyPageSchema = z
  .object({
    responseObject: z
      .object({
        activities: z.array(rawActivitySchema).max(MAX_HISTORY_PAGE_SIZE),
        nextCursor: responseCursorSchema.nullable().optional(),
        hasMore: z.boolean().optional(),
      })
      .strict(),
  })
  .passthrough();

/**
 * Parsed page (contract: `RecoveredActivityPage = { activities: unknown[];
 * nextCursor?: string; complete: boolean }`). Activities stay `unknown[]` on
 * purpose: normalizeActivity re-validates every raw payload (defense in
 * depth), so no downstream code may assume shape from the parse alone.
 * `complete` is true when the page is terminal — `nextCursor` is null/absent
 * or `hasMore` is false.
 */
export interface RecoveredActivityPage {
  activities: unknown[];
  nextCursor?: string;
  complete: boolean;
}

/**
 * Parses a history response body, or returns undefined when the envelope,
 * cursor, or any activity payload fails validation. Never throws for
 * untrusted input.
 */
export function parseHistoryPage(body: unknown): RecoveredActivityPage | undefined {
  const result = historyPageSchema.safeParse(body);

  if (!result.success) {
    return undefined;
  }

  const { activities, nextCursor, hasMore } = result.data.responseObject;

  return {
    activities: activities as unknown[],
    ...(nextCursor !== undefined && nextCursor !== null ? { nextCursor } : {}),
    complete: nextCursor === null || hasMore === false || nextCursor === undefined,
  };
}

/**
 * Builds the request URL from a validated query. The cursor parameter is
 * included only when non-empty (the contract's "omitted or empty on the
 * first page"); the limit is always present and defaults to 50.
 */
export function buildHistoryUrl(query: HistoryQuery): URL {
  const url = new URL(FOMO_HISTORY_ENDPOINT);

  if (query.cursor !== undefined && query.cursor.length > 0) {
    url.searchParams.set('cursor', query.cursor);
  }

  url.searchParams.set('limit', String(query.limit ?? DEFAULT_HISTORY_LIMIT));

  return url;
}
