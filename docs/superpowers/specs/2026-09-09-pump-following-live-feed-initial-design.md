# Pump Following Live Feed Design

## Goal

Extend Fomo Live Feed so a logged-in `pump.fun` tab can supply new trades from
every trader followed by the current Pump account. Pump and Fomo events share
one chronological feed, while users can filter by source. No Pump credentials,
manual wallet list, per-trader polling, or pre-connection history backfill is
introduced.

## Product decisions

- A Fomo tab and a Pump tab are independent live sources. Both may remain open
  in background tabs; closing one source must not interrupt the other.
- Pump capture starts at the moment the extension observes a valid live stream.
  Earlier Pump activity is not imported.
- Only traders present in the logged-in Pump account's Following set are kept.
- Pump uses page-real-time observation. The extension must not poll every
  followed trader's Activity page.
- Fomo and Pump events render in one feed. Source selection supports All, Fomo,
  and Pump.
- A source event may carry one or both source badges. A duplicate observed by
  both platforms is stored and rendered once.
- Trader identity is merged by exact public wallet address first, then by exact
  normalized handle when no wallet is available. Fuzzy matching is forbidden.
- Stablecoin counter-legs belonging to the same swap are suppressed or merged,
  while transfers, deposits, and withdrawals remain visible.
- Event market cap is displayed only when the real-time event contains it. No
  quote API, authentication layer, or new market-data cache is added.

## Feasibility gate

Implementation begins with a redacted Pump protocol capture. The spike must
prove that the page's live transport provides, directly or through correlated
messages, these fields:

- trader identifier or wallet;
- transaction hash or stable event identifier;
- action;
- token address and symbol;
- chain;
- amount or enough values to calculate USD amount;
- occurrence time.

The same spike must identify how the page exposes the current Following set and
how follow/unfollow changes can be observed. If the live stream lacks a required
field, development pauses for a design revision. It must not silently switch to
high-frequency Activity polling.

## Capture architecture

Pump receives two content-script layers matching the existing Fomo boundary:

1. A MAIN-world interceptor installed at `document_start` observes only the
   confirmed Pump WebSocket/fetch/XHR transport and publishes a namespaced,
   bounded window envelope. It never reads cookies, authorization headers,
   wallet signatures, or token values.
2. An isolated bridge validates `window.source`, the exact Pump origin,
   namespace, protocol version, message kind, and payload bounds before sending
   a typed extension message to the service worker.

The service worker keeps independent Fomo and Pump connection states. Pump is
reported as connected only after both a usable Following snapshot and the
confirmed live transport are present. Page presence alone is not a connection.

## Event model

The canonical event evolves without discarding existing version-1 Fomo rows.
New rows contain:

- `sources`: non-empty set of `fomo` and/or `pump`;
- source-specific event identifiers;
- optional `transactionHash`;
- optional public trader wallet;
- optional source profile URLs;
- the existing canonical trader, token, action, financial, and timing fields.

Stored version-1 events migrate to `sources: ['fomo']`. Rendering and query
validation accept only the versioned canonical shapes defined by the domain
module.

## Normalization and filtering

Pump raw messages are parsed by a Pump-specific bounded schema and normalized
into the canonical event. Chain names and IDs resolve through an explicit Pump
network catalog; unknown values remain `unknown` and do not borrow Fomo's
network mapping.

The Following membership check happens before persistence. The membership set
uses the exact Pump user/wallet identifier confirmed by the protocol capture.
Follow/unfollow updates replace or incrementally update the set without
importing history.

Stablecoin counter-leg merging uses transaction hash plus chain. Only a
confirmed stablecoin leg in the same transaction is suppressed. The extension
does not infer a counter-leg from amount and time alone.

## Deduplication

Deduplication uses this order:

1. exact chain and transaction hash;
2. exact source and source event identifier;
3. conservative cross-source fingerprint containing resolved trader identity,
   chain, token address, action, rounded event time, and amount.

The conservative fingerprint is used only inside a short bounded window. If any
required field is absent or conflicts, both events are retained. When a second
source confirms an existing event, its source badge and source-specific links
are merged into that stored row and one change notification is broadcast.

## UI

The current three-row card structure is preserved:

1. avatar, display name, inline note, and relative time;
2. action, token icon and symbol, chain badge, amount, and event market cap;
3. `CA:`, truncated contract address, and aligned copy button.

Token order and layout do not change. Cards become slightly denser through
padding and gap adjustments only. The existing action-colored borders remain.

Small source icons are added without creating another row:

- a single Fomo or Pump badge for single-source events;
- lightly overlapped Fomo and Pump badges for confirmed dual-source events;
- source badges expose tooltips, accessible labels, keyboard focus, and platform
  profile navigation.

The locally bundled official Fomo and Pump assets are the production source of
truth. The previous generic extension icon and temporary `P` placeholder are
not used as source badges. The assets come from the official public endpoints
`https://fomo.family/favicon.svg` and `https://pump.fun/icon.png`; runtime UI
never hotlinks them.

The compact source selector supports All, Fomo, and Pump using icons. It
composes with the existing action, chain, and market-cap filters. Transfers and
withdrawals remain unaffected by the buy/sell/thesis toggles.

The selected source also controls which badges are visible on a matching card:

- All shows every confirmed source badge on the canonical event;
- Fomo shows only the Fomo badge, including on a dual-source event;
- Pump shows only the Pump badge, including on a dual-source event.

This is presentation-only. Selecting one source never removes the other source
from storage, changes deduplication, or disconnects its observer. The filter
state is shared by the compact toolbar and the full filter popover.

The filter popover adds an inclusive buy-amount range in raw USD alongside the
existing market-cap range. The range applies only to `buy` events: buys with a
missing or non-finite USD amount are hidden while the range is active, while
sells, theses, transfers, and withdrawals remain unaffected. Blank bounds are
open-ended, zero is valid, a reversed range keeps the last valid filter and
shows an inline error, and Reset clears both amount bounds.

## Connection and empty states

Fomo and Pump each show a compact source status with a tooltip:

- connected;
- page open but login or live stream unavailable;
- disconnected;
- malformed/unsupported protocol.

No-trade and disconnected states are distinct. A connected Pump tab waiting for
a followed trader's next transaction must say it is waiting, not disconnected.
Stored history remains readable when either source is offline.

## Sound and navigation

The existing global buy-sound setting applies to both sources and remains off by
default. A cross-source duplicate plays at most one sound. Backfill is absent,
so Pump never plays sounds for older activity.

Clicking a source badge opens that platform's trader profile. Token navigation
uses the event's source-specific token link; a dual-source event defaults to
Pump while both profile source badges remain independently actionable.

## Privacy and diagnostics

- Pump messages are accepted only from exact HTTPS Pump origins.
- Raw frames are never persisted or logged.
- Diagnostics contain bounded field names, counters, closed error codes, and
  timestamps only.
- Existing Fomo history, annotations, financial display settings, filters,
  theme, display mode, and notification settings survive the migration.

## Verification

Unit tests cover Pump schemas, normalization, Following membership, counter-leg
merging, source merging, query filters, navigation, and connection state.
Integration tests cover MAIN-world to isolated-world to worker ingestion.
End-to-end tests exercise Fomo-only, Pump-only, dual-source, background-tab,
disconnect/reconnect, follow/unfollow, side panel, floating window, document
picture-in-picture, and single buy-sound behavior. The release gate remains
typecheck, the full Vitest suite, WXT build, Playwright coverage, and local
unpacked-extension verification.
