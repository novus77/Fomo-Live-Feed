# Feed Recovery, Chain Coverage, Translation, and Localization Design

**Status:** Proposed for implementation planning  
**Date:** 2026-08-21  
**Product:** Fomo Live Feed Chrome extension  
**Target browser:** Chrome 138 or newer on desktop

## 1. Summary

This release makes the Side Panel trustworthy after missed frames and browser
reconnection, adds an explicit manual refresh path, supports the six chains in
the current product scope, automatically translates KOL opinions on-device,
and localizes the extension UI in English and Simplified Chinese.

The implementation preserves one canonical ingest path. Live WebSocket events,
recovered history, and manually refreshed history must all pass through the
same validation, normalization, deduplication, persistence, diagnostics, and
UI-notification stages. No recovery path may write directly to IndexedDB or
construct UI-only event objects.

## 2. Goals

1. Explain and fix legitimate Fomo activities missing from the extension.
2. Recover activities that happened while the Fomo tab or socket was offline.
3. Give the user a refresh control that performs a real synchronization, not
   merely a local React rerender.
4. Support BSC, Solana, Robinhood, Base, Ethereum, and X Layer with accurate
   badges and chain-specific address validation.
5. Automatically translate KOL thesis/opinion text locally with Chrome's
   Translator API.
6. Provide an independent `EN / 中文` UI-language switch.
7. Preserve privacy: no raw frames, authentication material, addresses, trade
   history, or opinion text may be sent to a new third-party service.

## 3. Non-goals

- Cloud synchronization across devices.
- Supporting ARC, Stable, Monad, Hyper EVM, or every chain displayed by Fomo.
- DOM scraping as a production recovery source.
- Calling unofficial Google Translate endpoints.
- Embedding Google Cloud Translation credentials in the extension.
- Translating usernames, token symbols, contract addresses, links, amounts, or
  other structured trade fields.
- Persisting translated opinion text in canonical event history in this
  release.
- Guessing Fomo internal network IDs from public EIP-155 chain IDs.

## 4. Current Evidence and Root-cause Boundaries

### 4.1 Missing activity

The supplied screenshot shows two recent `ineedtowin` buy activities in Fomo
that are absent from the open Side Panel. The screenshot proves a user-visible
gap, but does not prove which pipeline stage dropped the activities.

The likely causes, in investigation order, are:

1. A new or changed WebSocket topic/payload shape is rejected before ingest.
2. A Fomo internal `networkId` or numeric/string representation is outside the
   current strict schema or network catalog.
3. The activity is observed but rejected, deduplicated incorrectly, or fails
   during persistence/broadcast.
4. The activity happened before the observer attached or during a disconnected
   interval and therefore requires server-side recovery.

The fix must first reproduce the loss with a redacted authenticated capture and
localize it using bounded diagnostics. The parser is expanded only for fields
and shapes demonstrated by that evidence.

### 4.2 Unavailable trader metrics

`Followers` and `7d Win Rate` currently render `Unavailable` because the
production composition root intentionally uses an unavailable metric source.
This is not a formatting bug. Enabling these values requires a separately
verified authenticated Fomo metrics response and must continue to distinguish
7-day values from lifetime values.

### 4.3 Stale history after reconnection

The extension currently persists live WebSocket events and rereads local
IndexedDB. It has no verified server history adapter. Reopening the Fomo tab can
restore the live socket but cannot reconstruct activities emitted while the
socket was absent. A local refresh alone cannot solve this gap.

### 4.4 Solana rendered as Unknown

The current catalog recognizes Solana only through provisional
`networkId = 101`. Fomo may emit a different internal ID. Unknown-chain events
also intentionally fail trusted address validation, so their CA remains
visible but non-copyable. The observed UI is therefore the combined result of
an incomplete mapping and the intended security boundary.

## 5. Architecture

```text
Fomo WebSocket ───────────────┐
                              │
Reconnect recovery endpoint ─┼─> ActivityCandidate
                              │        │
Manual refresh endpoint ─────┘        v
                                  validate
                                     │
                                  normalize
                                     │
                                  deduplicate
                                     │
                                  IndexedDB
                                     │
                            events.changed (no payload)
                              ┌──────┴──────┐
                              v             v
                         Side Panel       Toasts

Opinion text ─> local language detection ─> Chrome Translator API
                                               │
                                               v
                                      ephemeral translation cache

UI locale setting ─> local message catalog ─> rendered UI strings
```

New responsibilities are split into four bounded units:

- `ActivitySyncService`: coordinates reconnect and manual recovery.
- `NetworkCatalog`: maps verified Fomo network IDs to the six supported chains.
- `OpinionTranslationService`: performs local detection/translation and owns
  ephemeral caching and lifecycle.
- `LocaleProvider`: resolves and persists the UI locale independently from
  opinion translation.

## 6. Activity Diagnostics and Schema Repair

### 6.1 Diagnostic additions

Diagnostics may add only these bounded fields:

- Candidate topic code from a closed enum.
- Numeric `networkId`, when present and a finite integer.
- Rejection stage from a closed enum.
- Missing canonical field names from an allowlist.
- Counts and timestamps already used by pipeline health.

Diagnostics must not include:

- Raw WebSocket frames or arbitrary payload fragments.
- Trader/user IDs, handles, names, or avatars.
- Token addresses, symbols, images, amounts, market cap, or price.
- Opinion/thesis text or external links.
- Cookies, headers, authorization material, or wallet data.

The Settings diagnostics UI shows an aggregate table of rejection counts by
stage and unknown numeric network IDs with occurrence counts. It never displays
the event that produced the diagnostic.

### 6.2 Evidence workflow

An authenticated manual test captures only the minimum structural fixture
needed to reproduce each missed shape. Before committing a fixture:

1. Replace all identity, address, amount, text, URL, and timestamp values with
   synthetic values of the same type.
2. Preserve field names, nesting, event type, and numeric network ID.
3. Verify that the unmodified parser rejects the fixture for the expected
   reason.
4. Add the narrow schema change and verify the candidate reaches canonical
   ingest.

## 7. Reconnect Recovery and Manual Refresh

### 7.1 Recovery source gate

The server recovery adapter remains disabled until an authenticated Fomo
history request has been observed and converted to a redacted fixture. The
fixture must establish:

- Request URL pattern and method.
- Authentication behavior using the existing Fomo session.
- Pagination or time-window parameters.
- Response envelope and activity array location.
- Ordering, timestamp, source event ID, and end-of-page semantics.
- 401/403 behavior and rate-limit behavior.

The implementation must not infer an endpoint from a third-party repository or
silently scrape the Fomo DOM.

### 7.2 Incremental cursor

The local sync cursor is derived from persisted canonical history:

```ts
interface ActivitySyncCursorV1 {
  schemaVersion: 1;
  latestOccurredAt: number;
  latestSourceEventId?: string;
}
```

Recovery asks for a bounded overlap before `latestOccurredAt` to cover clock
skew and pagination boundaries. Every recovered item uses canonical ingest, so
existing event IDs and fingerprints suppress duplicates.

The cursor is advanced only by successfully persisted canonical events. A
failed fetch or partially rejected page cannot skip unseen server items.

### 7.3 Trigger policy

Synchronization runs when:

- Connection changes from disconnected/offline to connected and
  authenticated.
- The user presses the refresh button.
- The Side Panel opens connected but the last successful synchronization is
  older than five minutes.

Automatic triggers are coalesced. There is at most one active sync. A trigger
received during a sync sets a dirty flag and causes one bounded follow-up.

### 7.4 Refresh states

The Side Panel header adds an icon-only refresh button next to Settings with an
accessible label and tooltip. It has these states:

- `idle`: enabled.
- `syncing`: spinner, disabled, `Refreshing…` status.
- `updated`: completed with one or more new events.
- `current`: completed with no new events.
- `offline`: unavailable because Fomo is disconnected.
- `login-required`: unavailable because authentication is absent.
- `recovery-unavailable`: local history was reloaded, but no verified server
  recovery adapter exists.
- `failed`: existing history stays visible and a retry action is offered.

Refreshing must never clear visible history while the request is in flight.
New recovered events appear newest-first through the existing
`events.changed` convergence path.

## 8. Supported Chains and Contract Addresses

### 8.1 Canonical chain model

```ts
type ChainKey =
  | 'bsc'
  | 'solana'
  | 'robinhood'
  | 'base'
  | 'ethereum'
  | 'x-layer'
  | 'unknown';
```

ARC, Stable, Monad, and Hyper EVM are outside the current product scope. Events
from those networks remain `unknown` rather than being mislabeled.

### 8.2 Mapping evidence

Every catalog entry records:

```ts
interface NetworkCatalogEntry {
  networkId: number;
  chain: Exclude<ChainKey, 'unknown'>;
  status: 'verified-from-capture' | 'provisional-unverified';
  source: string;
}
```

Runtime display and trusted CA actions use only `verified-from-capture`
mappings. Provisional mappings remain visible in diagnostics but render as
Unknown in user-facing activity cards.

The supplied list of chains proves product scope, not Fomo's internal numeric
IDs. A real redacted frame must verify each ID before enabling its badge and CA
copy behavior.

### 8.3 Address validation

- Ethereum, BSC, Base, and X Layer use strict 20-byte hexadecimal EVM address
  validation and lowercase canonical display.
- Solana uses decoded Base58 length validation for a 32-byte public key, not
  merely a character-pattern check.
- Robinhood gets a dedicated validator based on its verified captured address
  format. It must not be assumed to be EVM or Solana.
- Unknown or unverified chains show selectable raw CA text without copy or
  navigation actions.

Once a mapping is verified, an idempotent IndexedDB migration reclassifies old
`unknown` rows carrying that numeric `networkId`. Migration validates the
address before enabling copy and does not alter event IDs or timestamps.

## 9. Automatic On-device Opinion Translation

### 9.1 Browser requirement

The extension raises `minimum_chrome_version` from `114` to `138`. Chrome's
Translator and Language Detector APIs are stable from Chrome 138 and available
to extensions. Chrome owns the local expert models and language-pack lifecycle.

Official references:

- <https://developer.chrome.com/blog/ai-api-updates-io25>
- <https://developer.chrome.com/docs/ai/get-started>
- <https://developer.chrome.com/docs/ai/built-in>

### 9.2 Independent translation preference

Opinion translation is separate from UI locale:

```ts
interface OpinionTranslationSettingsV1 {
  enabled: boolean;
  targetLanguage: 'auto' | 'zh' | 'en';
}
```

Defaults are `enabled: true` and `targetLanguage: 'auto'`. `auto` resolves once
from the Chrome/OS preferred language, not from the extension's `EN / 中文`
switch. Changing the UI locale never changes the translation target.

### 9.3 Translation behavior

- Only non-empty `thesis` text is eligible.
- Language detection runs first. Text already in the target language is shown
  unchanged without creating a translator.
- The original opinion renders immediately.
- While model creation/download or translation is pending, the card shows a
  localized `Translating…` indicator without blocking the trade card.
- On success, the translated text becomes primary and `View original` toggles
  the original text.
- On unsupported hardware, unavailable language pair, download failure, or
  translation failure, the original remains primary and a compact localized
  unavailable state is shown.
- URLs inside opinion text remain plain text; translation output is always
  rendered as text, never HTML.

### 9.4 Model download and user activation

Chrome may require a meaningful user interaction before downloading a missing
language model. Therefore:

- If the language pair is already available, translation starts automatically.
- If a download is required and Chrome refuses creation without activation,
  the header shows a one-time localized `Enable local translation` action.
- The user's action starts the browser-managed download and exposes progress.
- After activation, visible opinion cards translate automatically; future
  cards require no per-card click.

### 9.5 Caching and privacy

Translation uses an in-memory bounded LRU keyed by:

```text
SHA-256(original text) | source language | target language
```

The cache stores at most 200 results and is destroyed with the extension page.
Canonical IndexedDB event rows retain only the original opinion. No translation
request, source text, or result is sent to the extension worker or any remote
server.

## 10. English and Simplified Chinese UI

### 10.1 Locale model

```ts
type UiLocale = 'en' | 'zh-CN';

interface UiLocaleSettingsV1 {
  schemaVersion: 1;
  locale: UiLocale;
}
```

On first install, Chinese Chrome locales resolve to `zh-CN`; all others resolve
to `en`. A user selection in `chrome.storage.local` overrides the browser
locale and survives restart.

### 10.2 Switch behavior

The Side Panel header contains a compact `EN / 中文` segmented control. The
selected locale updates immediately without reload. It affects only extension
interface strings.

It does not change:

- Opinion translation target.
- Trader names or handles.
- Token symbols or addresses.
- Stored activity fields.
- Fomo page language.

### 10.3 Localization coverage

All user-visible extension-owned strings move behind typed message keys:

- Header, connection states, refresh states, and fallback page.
- Search, filters, chips, action names, chain labels, and empty/error states.
- Metric labels and unavailable states.
- Settings, annotation controls, diagnostics, and privacy explanations.
- CA copy feedback and translation states/actions.
- Toast labels and accessibility names.

Dynamic untrusted values are passed as escaped interpolation arguments and are
never treated as message keys or markup.

## 11. Trader Metrics

Trader metrics are recovered independently from event-history sync. The
production adapter may be enabled only after a real authenticated response is
captured, redacted, and shown to contain unambiguous periods.

Rules remain:

- `pnl7d` and `winRate7d` must come from an explicitly identified seven-day
  window.
- Lifetime values must never be labeled as seven-day values.
- Followers may be used only when the response clearly identifies follower
  count.
- 401/403 returns the login-required/unavailable state without retries that
  could lock or spam the Fomo account.
- Metric failure never prevents an activity from being persisted or displayed.

## 12. Failure Handling

- WebSocket parser drift: reject narrowly, increment redacted diagnostics, keep
  the observer alive.
- Unknown network ID: persist the event as Unknown, show numeric ID only in
  Settings diagnostics, and keep CA non-interactive.
- Recovery 401/403: show login required; keep old history.
- Recovery rate limit/server failure: preserve history, back off, and allow a
  later manual retry.
- Malformed recovery item: reject only that item, continue the page, and do not
  advance beyond an unprocessed pagination boundary.
- Translation unavailable/failure: show original opinion; never suppress the
  activity card.
- Locale catalog missing key: fail tests/build; production fallback is the
  English message, never an empty label.

## 13. Data and Migration

New local preferences are versioned and migration-safe:

```ts
interface LocalSettingsV2 {
  schemaVersion: 2;
  // Existing V1 fields remain unchanged.
  uiLocale: 'en' | 'zh-CN';
  opinionTranslation: {
    enabled: boolean;
    targetLanguage: 'auto' | 'zh' | 'en';
  };
}
```

V1 migrates without deleting annotations, muted traders/chains, metric slots,
or toast settings. `uiLocale` is initialized from the Chrome UI locale;
translation defaults to enabled/auto.

Canonical event schema remains `TradeEventV1`. Chain reclassification is an
idempotent data migration over existing `networkId` values; translated text is
not added to event records.

## 14. Security and Privacy

- Recovery and metrics requests are restricted to explicitly verified Fomo
  origins and use the existing authenticated browser session.
- No new broad host permission such as `<all_urls>` is permitted.
- Chrome Translator and Language Detector run locally; the extension does not
  add a translation host permission.
- Translation text remains in the Side Panel process and is not sent through
  runtime messaging.
- Refresh notifications and activity-change messages remain closed signals
  without event payloads.
- All recovered network data passes the same URL/address/text bounds as live
  events.

## 15. Testing Strategy

### Unit tests

- New real payload shapes fail before parser repair and pass after it.
- Every verified Fomo network ID maps to exactly one supported chain.
- Provisional/unknown IDs remain Unknown and non-copyable.
- EVM, Solana, and Robinhood validators accept/reject chain-specific fixtures.
- Settings V1 migrates to V2 without losing existing preferences.
- Typed English and Chinese catalogs have identical keys and no empty values.
- UI locale and translation target change independently.
- Translation availability, language detection, model download, success,
  failure, caching, stale completion, and unmount cleanup.
- Sync trigger coalescing, cursor overlap, pagination, partial rejection,
  401/403, retry, and cursor advancement.

### Integration tests

- Live and recovered copies of the same event produce one IndexedDB row.
- Reconnection recovers events emitted while the socket was absent.
- Manual refresh recovers missed events and emits bounded `events.changed`
  notifications.
- Sync and live ingest racing with each other remain idempotent.
- An unknown Solana Fomo ID is diagnosed; after adding the verified mapping,
  the same fixture renders SOL and exposes copy for a valid address.
- Translation never crosses the worker/runtime boundary.

### Browser E2E

- Close the Fomo fixture, emit activities during the gap, reconnect, and verify
  the Side Panel fills the gap without reload.
- Use Refresh to fetch new fixture history and verify status transitions.
- Verify all six supported chain badges and address-copy rules at 280px width.
- Verify an English opinion automatically becomes Chinese and can reveal the
  original when the local model test double is available.
- Verify translation-unavailable fallback preserves the original.
- Switch `EN / 中文` and verify UI strings change while translation target and
  trade data do not.
- Restart the extension and verify locale/preferences/history migration.

### Manual authenticated checkpoint

Release remains blocked until a real logged-in Fomo session confirms:

1. At least one previously missed payload shape and its exact rejection stage.
2. The history/recovery endpoint contract and authentication behavior.
3. Numeric Fomo network IDs for BSC, Solana, Robinhood, Base, Ethereum, and X
   Layer.
4. The Robinhood address format.
5. A real seven-day metrics response before enabling metrics.
6. Reconnection fills an observed offline gap without duplicates.
7. Chrome downloads/uses a translation language pack and keeps opinion text
   local.

## 16. Acceptance Criteria

1. A supported valid live activity is visible in the open Side Panel within
   seconds and is not lost because of a newly evidenced payload shape.
2. After disconnecting and reconnecting, activities from the offline interval
   are recovered automatically through the verified Fomo history adapter.
3. The refresh button performs a real sync and reports an honest result.
4. BSC, Solana, Robinhood, Base, Ethereum, and X Layer render the correct badge
   only for verified Fomo network IDs.
5. Valid supported-chain addresses copy; unknown/unverified addresses remain
   visible but non-interactive.
6. Eligible opinion text translates automatically on-device without blocking
   the event card; failure preserves the original.
7. `EN / 中文` updates all extension UI text immediately and does not change
   opinion translation settings or activity data.
8. No translation text, raw activity, authentication material, or user history
   is sent to a new remote service.
9. Existing local history, annotations, metric choices, mute settings, and
   unread state survive migration.
10. Unit, integration, production build, Chromium E2E, and authenticated manual
    checkpoints pass before release.

