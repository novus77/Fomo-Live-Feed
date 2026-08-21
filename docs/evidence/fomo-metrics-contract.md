# Fomo metrics contract (evidence)

> **Status: PROVISIONAL-UNVERIFIED — synthetic reconstruction.**
>
> No live authenticated Fomo traffic could be captured in this environment, so
> the endpoint and JSON paths below are a plausible reconstruction consistent
> with `src/fomo/enrichment-client.ts` (`parseLeaderboardMetrics`) and
> `docs/manual-testing.zh-CN.md` section 8. The matching fixture
> `tests/fixtures/fomo-metrics-7d.redacted.json` contains only synthetic
> values. Treat everything here as provisional until a real authenticated
> response is captured, redacted, and this contract is re-verified; the
> production adapter stays disabled (`unavailableMetricSource`) until then
> (plan Task 8 step 3).

## Capture integrity

- SHA-256 of the unredacted capture: `sha256-redacted-outside-git` (placeholder
  — replace with the real digest once a capture exists).
- The unredacted capture is held outside git and is never committed.
- Promotion to `verified-from-capture` requires one real authenticated metrics
  response that explicitly identifies a seven-day window and includes
  followers, redacted and hashed.

## Endpoint (provisional)

| Item | Value |
| --- | --- |
| Method | `GET` |
| Origin | `https://prod-api.fomo.family` |
| Path | `/v2/users/{traderId}/leaderboard` |
| Credentials | browser-managed authenticated session (`credentials: 'include'`); the extension never reads or stores session credentials, request headers, or tokens |

This is the endpoint already wired in `src/fomo/enrichment-client.ts`
(`FomoLeaderboardMetricSource`) and referenced by `docs/manual-testing.zh-CN.md`
section 8; it remains provisional until a real authenticated response exists.

## JSON paths (provisional)

| Metric | Primary path | Alternate path | Notes |
| --- | --- | --- | --- |
| 7-day PnL | `responseObject.timeframes["7d"].pnl` | `responseObject.pnl7d` | USD absolute value (signed); MUST NOT be substituted from a lifetime window. |
| 7-day win rate | `responseObject.timeframes["7d"].winRate` | `responseObject.winRate7d` | Percentage-points form (e.g. `62.5`, not `0.625`) — UNVERIFIED, confirm on capture. |
| followers | `responseObject.followers` | `responseObject.userStats.followers` (candidate, unverified) | Integer count; path provisional. |

Parsing rule (matches `parseLeaderboardMetrics`): accept a metric ONLY when the
response explicitly identifies the `"7d"` window — either a
`timeframes["7d"]` object with `pnl`/`winRate`, or top-level `pnl7d` /
`winRate7d` keys. Lifetime-only responses are rejected and never mapped into
the 7-day slots (design spec section 5.2).

## Missing-data semantics (UNVERIFIED)

Capture must confirm whether a missing metric is `null`, an absent field, or
`0`. The extension renders missing metrics as unavailable and never invents a
`0` or an incorrect percentage.

## Status-code behavior (provisional)

| Status | Interpretation |
| --- | --- |
| 401 / 403 | auth failure → unavailable snapshot |
| 404 | trader not found → unavailable snapshot |
| 429 | rate limited → retryable with bounded backoff |
| 5xx / other non-2xx | server failure → unavailable snapshot |

Enrichment never blocks or delays activity ingest or Toast broadcast; every
failure degrades to an unavailable snapshot (design spec section 5.2,
`src/fomo/enrichment-client.ts`).

## Fixture

`tests/fixtures/fomo-metrics-7d.redacted.json` — a synthetic redacted response
using `responseObject.timeframes["7d"]` plus `responseObject.followers`, with
top-level `note` / `captureIntegrity` fixture annotations.

## Requirements before release

1. Capture one real authenticated leaderboard response that explicitly
   identifies a seven-day window and includes followers.
2. Confirm PnL units, win-rate scale (`62.5` vs `0.625`), and missing-value
   representation (`null` vs absent vs `0`).
3. Redact all values, hash the unredacted capture, and replace
   `sha256-redacted-outside-git`.
4. Promote this contract to `verified-from-capture`; only then enable the
   production metric adapter (plan Task 8 step 3).
