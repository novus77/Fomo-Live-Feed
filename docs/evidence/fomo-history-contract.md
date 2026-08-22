# Fomo history contract (evidence)

> **Status: PROVISIONAL-UNVERIFIED — synthetic reconstruction.**
>
> No live authenticated Fomo traffic could be captured in this environment, so
> the endpoint, parameters, response shape, and status behavior below are a
> plausible reconstruction for the recovery plan (Task 4 builds
> `src/fomo/history-client.ts` from this contract). Every value is synthetic;
> the matching fixture `tests/fixtures/fomo-history-page.redacted.json`
> preserves the envelope and replaces every identity, address, amount,
> timestamp, URL, and prose value. Treat everything here as provisional until a
> real authenticated request/response pair is captured and this contract is
> re-verified.

## Capture integrity

- SHA-256 of the unredacted capture: `sha256-redacted-outside-git` (placeholder
  — replace with the real digest once a capture exists).
- The unredacted capture is held outside git and is never committed.
- Promotion to `verified-from-capture` requires a real authenticated capture of
  the Fomo activity list (Chrome DevTools → Network → Preserve log), redaction
  of all sensitive values, and replacement of the placeholder SHA above.

## Endpoint

| Item | Value |
| --- | --- |
| Method | `GET` |
| Origin | `https://prod-api.fomo.family` |
| Path | `/v2/activities/me` |
| Full example | `GET https://prod-api.fomo.family/v2/activities/me?cursor=&limit=` |

## Credentials behavior

- The request rides the browser-managed authenticated session for the Fomo
  origin (`credentials: 'include'` semantics). The extension issues the fetch
  against the Fomo origin and never reads, stores, or logs session credentials,
  request headers, or tokens.

## Request parameters (provisional)

| Parameter | Type | Meaning |
| --- | --- | --- |
| `cursor` | string, opaque, ≤ 512 chars | Pagination token; omitted or empty on the first page. |
| `limit` | integer, 1–200, default 50 | Page size. |
| `from` / `to` | ISO 8601 timestamps | Optional time-window bounds; provisional until captured. |

## Response

| Item | Value |
| --- | --- |
| Activity array path | `responseObject.activities[]` |
| Next-page cursor | `responseObject.nextCursor` (string, or `null` when at the end) |
| More-pages flag | `responseObject.hasMore` (boolean) |
| Ordering | newest-first by `createdAt` descending |
| End semantics | the page is terminal when `nextCursor` is `null` or `hasMore` is `false` |

Each `responseObject.activities[]` item uses the raw activity shape documented
in `fomo-activity-contract.md`, so recovered items feed the same
`normalizeActivity` path as live frames.

## Status-code behavior (provisional)

| Status | Interpretation | Retryable |
| --- | --- | --- |
| 200 | success | — |
| 401 | session missing or expired → login required | no |
| 403 | session rejected → login required | no |
| 429 | rate limited | yes — honor `Retry-After` with bounded backoff |
| 5xx | server failure | yes |
| other non-2xx | failure | no |

## Parser bounds (consumed by Task 4 `src/fomo/history-contract.ts`)

- `activities`: at most 200 items per page.
- `cursor`: at most 512 characters.
- The parser result must never carry arbitrary URLs, headers, or auth data.
- Parsed page type: `RecoveredActivityPage = { activities: unknown[]; nextCursor?: string; complete: boolean }`.

## Fixture

`tests/fixtures/fomo-history-page.redacted.json` preserves the envelope and
replaces every identity, address, amount, timestamp, URL, and prose value.
Top-level `note` and `captureIntegrity` keys are fixture annotations, not part
of the API envelope; the envelope is `responseObject`.

## Requirements before release

1. Capture one real authenticated request/response pair that populates the
   Fomo activity list.
2. Record the exact origin, path, query parameters, and observed status
   behavior (including 401/403/429).
3. Redact all values, hash the unredacted capture, and replace
   `sha256-redacted-outside-git`.
4. Promote this contract to `verified-from-capture`; only then enable the
   production history adapter.
