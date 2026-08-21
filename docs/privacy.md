# Privacy and data handling

This document describes what the Fomo Live Feed extension collects, where it
stores data, how long data is kept, and how data is deleted. It is written
for users and for reviewers of the MVP release.

## What the extension collects

The extension observes **one** kind of data: real-time `trading_activity`
frames that the authenticated Fomo page receives on
`wss://prod-api.fomo.family/ws` (design spec section 3). A MAIN-world
interceptor forwards only candidate frames to the isolated bridge; everything
else — non-JSON frames, unrelated topics, binary data — is ignored and never
read or logged. The interceptor never reads outbound WebSocket payloads
(where session tokens live) and never reads cookies, headers, or credentials.

From each accepted activity frame the extension derives a canonical trade
event: trader id/handle/display name/avatar, token address/symbol/image, chain,
action, USD amount, market cap, price, optional thesis comment, and
timestamps. Trader metric snapshots (7-day PnL, 7-day win rate, ...) are
stored only when enrichment produces them; the metric adapter is currently
DISABLED until a real redacted capture exists, so no authenticated REST
requests are made in the MVP.

The extension also stores data the user creates: trader annotations (label,
color, pin, mute) and local settings (notification options, metric slots,
filters, UI locale, and opinion-translation preferences). Diagnostics are
bounded and redacted (see below).

## What the extension never does

- Never reads, stores, or transmits private keys, seed phrases, signatures,
  or trading credentials (design spec section 9).
- Never exports Fomo cookies or authentication headers.
- Never automates order controls, places trades, copies trades, or touches
  wallet state on any page.
- Never uploads event history, annotations, settings, or diagnostics anywhere
  in the MVP. There is no backend, no third-party service, and no analytics
  SDK.

## Where data is stored

All data lives inside the extension's own browser profile. Chrome owns both
persistence mechanisms; no database server or local daemon is required
(design spec sections 6 and 12, acceptance 8).

### IndexedDB (Dexie, database `fomo-live-feed`)

- `events` — canonical trade event history, read state, and indexes over
  occurrence time, trader, chain, token address, and read state.
- `metrics` — trader metric snapshot cache with expiry metadata.

### `chrome.storage.local`

- `settings.v2` — versioned local settings, including UI locale and opinion
  translation preferences. A legacy `settings.v1` record is read once for
  migration and left in place so rollback remains possible.
- `annotations.v1` — versioned, sync-ready trader annotations (tombstones
  reserved for future multi-device sync).

### `chrome.storage.session` (ephemeral; cleared when the browser closes)

- Per-tab connection state (socket open / authenticated), the retention
  schedule due-time, and a closed pipeline-health projection: observer/socket
  booleans, bounded stage counters, timestamps, and a closed rejection-code
  enum. It contains no raw frames, addresses, free-form errors, cookies,
  headers, or credentials. Session storage is never part of event history and
  is cleared when the browser closes.

### In-memory only

- The bounded redacted diagnostic ring buffer (at most 100 records with a
  closed set of codes and allowlisted field NAMES; raw payloads, cookies,
  headers, comments, balances, addresses, and arbitrary URLs can never reach
  storage). Diagnostics are not persisted and are lost on worker restart.

## Retention defaults

- Event history: **30 days** or **20,000 events**, whichever limit is reached
  first. Cleanup runs in bounded batches (at most 500 deletions per run) and
  deletes by age first, then oldest overflow rows (design spec section 6;
  `src/background/retention.ts`).
- Metric cache entries expire according to the bounded TTL/backoff policy in
  the worker (`src/background/enrichment-client.ts`).
- Settings and annotations are kept until the user changes or deletes them.

## Deletion behavior

- Automatic: retention cleanup removes expired/overflow events in bounded
  batches while the worker runs.
- Uninstall: removing the extension removes the whole extension-owned profile
  storage (IndexedDB and `chrome.storage` areas) — Chrome deletes the
  extension's storage when the extension is uninstalled.
- There is no MVP backend to "forget" data from: nothing was uploaded, so
  there is nothing to revoke server-side.

## Cross-origin behavior

The extension requests host permissions for exactly
`https://fomo.family/*`, `https://www.fomo.family/*`,
`https://dexscreener.com/*`, and `https://gmgn.ai/*` — never
`<all_urls>` (design spec sections 4.4 and 9). The overlay content script
runs only on the supported trading hosts and never queries the host page
beyond its own marked host element; it does not read or modify the page's
wallet, form, or order state.

## External navigation

Links opened from the UI are built only by the verified builders in
`src/navigation/` and are HTTPS-only (Fomo profile/token pages). Untrusted
values render as text, never as unsanitized HTML.

## Feed recovery

The extension can backfill missed events after a reconnect or a manual refresh
by requesting the authenticated Fomo history endpoint. In the current release
this adapter is DISABLED until a real, redacted capture is verified, so no
authenticated REST request is issued. When enabled, recovered events are
processed through the same normalization and validation path as live frames,
and duplicates are skipped without re-broadcasting.

## On-device opinion translation

When the user opts in, optional trader thesis comments are translated inside
Chrome's Side Panel using the browser's built-in Chrome 138 AI translation
model. The source text is sent only to the local browser model; no translation
service, third-party endpoint, or remote API receives it. Translations are kept
in memory for the current Side Panel session only and are never persisted to
IndexedDB or `chrome.storage`. The first use may require downloading a local
language pack or enabling Chrome's on-device translation features; if the model
is unavailable the original thesis remains visible.

## Changes to this policy

Any change to what is collected, where data is stored, retention defaults,
upload behavior, or translation processing must update this document and the
design spec together.
