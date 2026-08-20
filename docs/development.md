# Development

This document covers setting up, building, testing, and extending the Fomo
Live Feed extension. It targets the codebase on the
`codex/fomo-live-feed` worktree.

## Prerequisites

- Node.js >= 22 (the repo pins the version in `.node-version`)
- pnpm (the repo uses `packageManager: pnpm@10.15.0`)
- Chrome or Chromium for manual validation; Playwright downloads its own
  Chromium build for the E2E suite

## Setup

```bash
pnpm install   # runs "wxt prepare" via postinstall to generate .wxt/types
```

## Development build (live reload)

```bash
pnpm dev
```

`wxt` serves the extension on a dev server and opens a browser with the
extension loaded. In Chrome, load `.output/chrome-mv3` as an unpacked
extension from `chrome://extensions` (enable Developer mode) if you prefer
to drive the build manually.

## Production build

```bash
pnpm build   # wxt build -> .output/chrome-mv3
```

The production artifact is `.output/chrome-mv3` (Manifest V3). Load it as an
unpacked extension in Chrome to validate against a real authenticated Fomo
session (see the Manual validation checkpoint in the implementation plan).

## Tests

### Unit and integration tests

```bash
pnpm test          # vitest run (tests/unit, tests/integration)
pnpm typecheck     # tsc --noEmit
```

### End-to-end tests

The E2E suite launches real Chromium with the production build loaded as an
unpacked extension, serves deterministic fixtures over an HTTPS
CONNECT-proxy fixture server, and drives the full capture -> ingest ->
toast -> history path.

```bash
pnpm build          # required first: the suite loads .output/chrome-mv3
pnpm test:e2e       # playwright test (tests/e2e)
```

Notes:

- Headless is the default and is CI-safe (recent Chromium supports MV3
  extensions in headless mode via `channel: 'chromium'`). To watch the
  browser while debugging locally:

  ```bash
  FOMO_E2E_HEADED=1 pnpm test:e2e
  ```

- The fixtures are served on the extension's REAL production hostnames
  (`fomo.family`, `dexscreener.com`, `gmgn.ai`, `www.fomo.family`) through a
  CONNECT proxy + self-signed certificate, so content scripts, match
  patterns, and the origin guards in `src/messaging/guards.ts` behave exactly
  as in production without touching the production manifest (see
  `tests/e2e/fixture-server.ts`). The certificate is generated at runtime
  with openssl and never committed.
- The popup is opened as the real browser-action popup
  (`chrome.action.openPopup()`) and driven over CDP, because Playwright does
  not attach action popups to a context's page list and a popup opened in a
  plain tab is (correctly) rejected by the popup sender guard.

### Full release gate

```bash
pnpm check      # typecheck + unit/integration tests + production build
pnpm test:e2e   # Chromium E2E suite
```

## Capturing and redacting an authenticated Fomo fixture

The Fomo enrichment adapter is deliberately DISABLED until a real,
redacted capture exists:

- `entrypoints/background.ts` wires `unavailableMetricSource` (not the
  `FomoLeaderboardMetricSource`) into the metric source, so the worker never
  issues an authenticated REST request.
- `tests/fixtures/fomo-leaderboard-7d.json` is a hand-authored SYNTHETIC
  shape-check, explicitly NOT a captured response. Its header comment says so.

To promote the adapter (plan Task 7 Step 2):

1. Log in to Fomo in Chrome with the extension loaded (or with DevTools
   open).
2. Capture one authenticated response to
   `GET https://prod-api.fomo.family/v2/users/{traderId}/leaderboard`
   (`credentials: include`) in the Network tab of DevTools.
3. Redact every user-identifying field: user handle, user id, avatar URLs,
   and any other personal data. Keep the metric fields
   (`responseObject.timeframes."7d".pnl` and `.winRate`, or the flat
   `pnl7d`/`winRate7d` shape).
4. Save the redacted response as `tests/fixtures/fomo-leaderboard-7d.json`,
   preserving the exact response shape.
5. If the verified production shape differs from both accepted shapes, update
   the parser in `src/fomo/enrichment-client.ts` AND the fixture together -
   never weaken the explicit 7-day-window requirement.
6. Switch the composition root in `entrypoints/background.ts` from
   `unavailableMetricSource` to the real adapter.
7. Add/update unit tests and re-run the full gate.

Do not release until the captured fixture is in place and every fixture
passes runtime schema validation (manual validation checkpoint in the plan).

## Supported hosts

Host permissions are declared ONLY in `wxt.config.ts` and mirrored by the
content-script match patterns; there is deliberately no `<all_urls>`:

| Host | Role |
| --- | --- |
| `https://fomo.family/*`, `https://www.fomo.family/*` | Fomo pages: MAIN-world WebSocket interceptor + isolated bridge |
| `https://dexscreener.com/*`, `https://gmgn.ai/*` | Supported trading pages: toast overlay |

To add a platform, add the HTTPS pattern to BOTH the manifest host
permissions and the overlay content-script matches (see
`src/overlay/trading-overlay.ts`), then update this table and the README.

## House rules

- Single quotes, 2-space indent, trailing commas.
- Strict TypeScript; no `any`; no new npm dependencies.
- Never weaken the origin catalog or the host permissions to make tests pass
  (design spec section 9).

## See also

- [Design specification](superpowers/specs/2026-08-20-fomo-live-feed-extension-design.md)
- [Implementation plan](superpowers/plans/2026-08-20-fomo-live-feed-extension.md)
- [Privacy behavior](privacy.md)
