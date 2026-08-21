# Feed Recovery, Translation, and Localization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover missed Fomo activity after reconnect or manual refresh, correctly support the six in-scope chains, automatically translate KOL opinions on-device, and localize the extension UI in English and Simplified Chinese.

**Architecture:** Live WebSocket and verified history responses converge on the existing `ActivityIngestor`; no recovery path writes directly to IndexedDB. Chrome 138's local Language Detector and Translator APIs run only in the Side Panel, while a typed locale provider owns UI language independently. Real Fomo endpoint, payload, network-ID, Robinhood-address, and metrics evidence are hard gates: unknown contracts remain disabled rather than guessed.

**Tech Stack:** WXT 0.21.x, Chrome Manifest V3, Chrome 138 Built-in Translator/Language Detector APIs, React 19, TypeScript 5.9, Zod 4, Dexie 4, Vitest, Testing Library, Playwright.

---

## Scope and release gates

- Supported chains: BSC, Solana, Robinhood, Base, Ethereum, X Layer, plus the
  internal `unknown` state.
- Do not add ARC, Stable, Monad, or Hyper EVM UI support.
- Do not add `<all_urls>`, `cookies`, or a translation-service host permission.
- Do not call unofficial Google Translate endpoints or persist translations in
  canonical event history.
- Tasks 3, 4, and 8 may be completed only with the redacted evidence produced
  by Task 1. If the evidence is unavailable, leave the production adapter or
  mapping disabled and report the task as blocked; never substitute a public
  chain ID or third-party endpoint.
- Existing IndexedDB history, annotations, mute settings, metric slots, unread
  state, and the three-card Toast limit must survive the release.

## Planned file structure

```text
docs/evidence/
  fomo-activity-contract.md              Redacted observed payload variants
  fomo-history-contract.md               Authenticated history endpoint contract
  fomo-network-catalog.md                Verified Fomo IDs and address formats
  fomo-metrics-contract.md               Verified period-specific metrics fields
entrypoints/
  background.ts                          Sync routing and triggers
  sidepanel/App.tsx                      Browser translation/locale dependencies
  sidepanel/sidepanel.css                Refresh, locale, translation states
src/
  background/
    activity-sync.ts                     Single-flight recovery coordinator
  domain/
    activity.ts                          Six-chain canonical union
    settings.ts                          LocalSettingsV2
  fomo/
    history-client.ts                    Verified authenticated history adapter
    history-contract.ts                  Captured request/response parser
    network-map.ts                       Verified internal network catalog
    raw-schema.ts                        Evidenced live/recovered payload shapes
    normalize.ts                         Shared canonical normalization
    enrichment-client.ts                 Verified metrics adapter
  i18n/
    catalog.ts                           Typed English/Chinese catalogs
    LocaleProvider.tsx                   Independent UI locale state
  translation/
    browser-translation.ts               Browser API boundary
    opinion-translation.ts               Detection/session/cache coordinator
    use-opinion-translation.ts            React lifecycle adapter
  messaging/
    protocol.ts                          Sync commands/status messages
    guards.ts                            Sender trust boundaries
  popup/
    EventCard.tsx                        Localized translated opinion rendering
    SettingsPanel.tsx                    Translation target + diagnostics
  sidepanel/
    RefreshButton.tsx                    Manual sync control/status
    SidePanelApp.tsx                     Reconnect trigger + locale controls
    ChainBadge.tsx                       Six supported chain presentations
    CopyableAddress.tsx                  Verified per-chain copy gate
    PipelineDiagnostics.tsx              Unknown-network aggregate evidence
  storage/
    database.ts                          Idempotent unknown-chain migration
    event-repository.ts                  Sync cursor and reclassification methods
    local-preferences.ts                 V1 -> V2 preference migration
tests/
  fixtures/
    fomo-activity-variants.ts             Synthetic redacted payload structures
    fomo-history-page.redacted.json       Redacted captured recovery page
    fomo-metrics-7d.redacted.json         Redacted captured metrics response
  unit/
  integration/
  e2e/
```

### Task 1: Capture and lock the real Fomo contracts

**Files:**
- Create: `docs/evidence/fomo-activity-contract.md`
- Create: `docs/evidence/fomo-history-contract.md`
- Create: `docs/evidence/fomo-network-catalog.md`
- Create: `docs/evidence/fomo-metrics-contract.md`
- Create: `tests/fixtures/fomo-activity-variants.ts`
- Create: `tests/fixtures/fomo-history-page.redacted.json`
- Create: `tests/fixtures/fomo-metrics-7d.redacted.json`
- Modify: `docs/manual-testing.zh-CN.md`

- [ ] **Step 1: Reproduce the missing-event gap with diagnostics open**

Load the current production build, sign in to Fomo, open Settings diagnostics,
and record only this table for each visible Fomo item absent from the panel:

```text
Fomo visible time | candidate delta | accepted delta | rejected delta |
persisted delta | broadcast delta | rejection code | unknown network ID
```

Expected: the first diverging counter identifies observer/schema/dedup/storage/
broadcast, or all counters remain unchanged and establish a capture/recovery
gap. Do not copy opinion text, address, user identity, amount, or raw frames into
the document.

- [ ] **Step 2: Capture structural live payload evidence**

Use Chrome DevTools on an authenticated Fomo tab and capture the minimum
`trading_activity` envelope needed to reproduce each missing shape. Create
synthetic fixtures that preserve field names, nesting, type, and the exact
observed numeric `networkId`, while replacing every sensitive value. Every
fixture must satisfy this compile-time container:

```ts
export const redactedActivityVariants = [
  // Add one complete redacted record per observed payload variant.
] as const satisfies readonly {
  expectedAction: 'buy' | 'sell' | 'withdraw' | 'transfer' | 'thesis';
  expectedNetworkId: number;
  payload: Readonly<Record<string, unknown>>;
}[];
```

Before completing Task 1, the array must be non-empty and every entry must
contain the observed numeric ID and a complete synthetic payload accepted by
JSON serialization. A unit assertion must fail when the array is empty or an
entry lacks a numeric ID.

- [ ] **Step 3: Capture the authenticated history contract**

Close the Fomo tab, allow at least two followed-trader activities to occur,
reopen Fomo, and inspect authenticated REST requests that populate its own
activity list. Record in `docs/evidence/fomo-history-contract.md`:

```text
Method and exact origin/path pattern
Credentials behavior
Cursor/time-window request parameters
Response activity-array JSON path
Ordering and next-page/end semantics
401/403/429 behavior
```

Create `fomo-history-page.redacted.json` by preserving structure and replacing
all identities, addresses, amounts, timestamps, URLs, and prose. The evidence
document must include the SHA-256 of the unredacted capture held outside git so
reviewers can confirm the fixture derives from a real request without storing
the source data.

- [ ] **Step 4: Capture six-chain and metrics evidence**

For BSC, Solana, Robinhood, Base, Ethereum, and X Layer, record the exact numeric
Fomo `networkId` from a real activity and the observed address family. Capture
one authenticated metrics response that explicitly identifies a seven-day
window and followers.

Expected: `docs/evidence/fomo-network-catalog.md` contains six unique verified
IDs or explicitly marks an unobserved chain as blocked. Robinhood is classified
from evidence, never assumed EVM/Solana. `fomo-metrics-contract.md` identifies
exact JSON paths for 7-day PnL, 7-day win rate, and followers.

- [ ] **Step 5: Perform privacy review and commit evidence**

Run:

```bash
rg -n "cookie|authorization|bearer|0x[0-9a-fA-F]{40}|https://x\.com/|thesis|comment" docs/evidence tests/fixtures
git diff --check
```

Expected: no cookie/header/token, real EVM address, social URL, or real opinion
text remains. Manually verify Base58-like addresses and identities are synthetic.

```bash
git add docs/evidence tests/fixtures docs/manual-testing.zh-CN.md
git commit -m "test: capture redacted Fomo contracts"
```

### Task 2: Add bounded evidence for missing live activities

**Files:**
- Modify: `src/background/pipeline-health.ts`
- Modify: `src/background/diagnostics.ts`
- Modify: `src/background/ingest-activity.ts`
- Modify: `src/fomo/bridge.ts`
- Modify: `src/messaging/protocol.ts`
- Modify: `src/sidepanel/PipelineDiagnostics.tsx`
- Test: `tests/unit/pipeline-health.test.ts`
- Test: `tests/unit/diagnostics.test.ts`
- Test: `tests/integration/fomo-bridge.test.ts`
- Test: `tests/unit/PipelineDiagnostics.test.tsx`

- [ ] **Step 1: Write failing bounded-diagnostics tests**

Add a closed model:

```ts
export type ActivityRejectionStage =
  | 'observer-topic'
  | 'bridge-envelope'
  | 'raw-schema'
  | 'normalization'
  | 'deduplication'
  | 'storage'
  | 'broadcast';

export interface UnknownNetworkAggregate {
  networkId: number;
  count: number;
  lastSeenAt: number;
}
```

Tests must prove aggregates cap at 20 network IDs, counters saturate, timestamps
are finite non-negative integers, and schemas reject identity/address/amount/
opinion/URL/raw-payload keys.

- [ ] **Step 2: Verify RED**

Run:

```bash
corepack pnpm vitest run tests/unit/pipeline-health.test.ts tests/unit/diagnostics.test.ts tests/integration/fomo-bridge.test.ts tests/unit/PipelineDiagnostics.test.tsx
```

Expected: FAIL because the stage and unknown-network aggregates do not exist.

- [ ] **Step 3: Implement bounded aggregation at each boundary**

Record only closed stage codes, numeric IDs, counters, and timestamps. Do not
forward or persist raw candidates. An unknown ID increments its aggregate after
raw schema validation and before canonical normalization.

Render Settings rows such as:

```text
Unknown network 900001 · 3 events · last seen 1m ago
Raw schema rejection · 2
```

The numeric ID stays in Settings diagnostics and never appears as a trusted
chain badge.

- [ ] **Step 4: Verify and commit**

```bash
corepack pnpm vitest run tests/unit/pipeline-health.test.ts tests/unit/diagnostics.test.ts tests/integration/fomo-bridge.test.ts tests/unit/PipelineDiagnostics.test.tsx
corepack pnpm typecheck
git add src/background src/fomo/bridge.ts src/messaging src/sidepanel/PipelineDiagnostics.tsx tests
git commit -m "feat: diagnose missing Fomo activities"
```

### Task 3: Repair payload parsing and implement the six-chain catalog

**Depends on:** Task 1 live-payload and network evidence.

**Files:**
- Modify: `src/domain/activity.ts`
- Modify: `src/domain/settings.ts`
- Modify: `src/fomo/raw-schema.ts`
- Modify: `src/fomo/normalize.ts`
- Modify: `src/fomo/network-map.ts`
- Modify: `src/navigation/contract-address.ts`
- Modify: `src/sidepanel/chain-presentation.tsx`
- Modify: `src/sidepanel/CopyableAddress.tsx`
- Modify: `src/storage/database.ts`
- Modify: `src/storage/event-repository.ts`
- Test: `tests/unit/fomo-normalize.test.ts`
- Test: `tests/unit/navigation.test.ts`
- Test: `tests/unit/ChainBadge.test.tsx`
- Test: `tests/unit/CopyableAddress.test.tsx`
- Test: `tests/unit/event-repository.test.ts`

- [ ] **Step 1: Write failing parser and chain tests from redacted fixtures**

Replace the canonical union with:

```ts
export type ChainKey =
  | 'bsc'
  | 'solana'
  | 'robinhood'
  | 'base'
  | 'ethereum'
  | 'x-layer'
  | 'unknown';
```

For each verified captured ID, assert the exact chain. Assert every provisional
or unlisted ID remains `unknown`. Add one failing test per observed payload
variant before modifying `rawActivitySchema`.

- [ ] **Step 2: Write failing address-validator tests**

Expose:

```ts
export type ContractAddressValidation =
  | { ok: true; canonical: string }
  | { ok: false; reason: 'unknown-chain' | 'invalid-address' };
```

Tests require:

- EVM: exactly `0x` plus 40 hexadecimal characters, canonical lowercase.
- Solana: Base58 decode succeeds and yields exactly 32 bytes.
- Robinhood: exact format documented by Task 1 evidence.
- Unknown/provisional: always `unknown-chain` and never copyable.

- [ ] **Step 3: Verify RED**

```bash
corepack pnpm vitest run tests/unit/fomo-normalize.test.ts tests/unit/navigation.test.ts tests/unit/ChainBadge.test.tsx tests/unit/CopyableAddress.test.tsx tests/unit/event-repository.test.ts
```

Expected: FAIL on new payload variants, chain keys, verified IDs, and address
rules.

- [ ] **Step 4: Implement narrow parser repair and verified catalog**

Keep the catalog shape:

```ts
export interface NetworkCatalogEntry {
  networkId: number;
  chain: Exclude<ChainKey, 'unknown'>;
  status: 'verified-from-capture' | 'provisional-unverified';
  source: string;
}
```

Only entries documented in `fomo-network-catalog.md` may use
`verified-from-capture`. `mapNetworkId` returns `unknown` for provisional
entries. Update settings schemas, filter labels, Toasts, and Side Panel badges
to the new union without preserving obsolete chains as aliases.

- [ ] **Step 5: Add idempotent unknown-row reclassification**

Add:

```ts
reclassifyUnknownEvents(
  mappings: ReadonlyMap<number, Exclude<ChainKey, 'unknown'>>,
): Promise<{ scanned: number; updated: number }>;
```

Update only rows with `chain === 'unknown'`, a verified numeric `networkId`, and
a valid address for the resolved chain. Preserve event ID, read state,
timestamps, metrics, and annotations. Running twice returns `updated: 0` the
second time.

- [ ] **Step 6: Verify and commit**

```bash
corepack pnpm vitest run tests/unit/fomo-normalize.test.ts tests/unit/navigation.test.ts tests/unit/ChainBadge.test.tsx tests/unit/CopyableAddress.test.tsx tests/unit/event-repository.test.ts tests/unit/local-preferences.test.ts
corepack pnpm typecheck
corepack pnpm build
git add src/domain src/fomo src/navigation src/sidepanel src/storage tests/unit
git commit -m "feat: support verified Fomo chains"
```

### Task 4: Build the authenticated history adapter and sync coordinator

**Depends on:** Task 1 history evidence and Task 3 canonical parser.

**Files:**
- Create: `src/fomo/history-contract.ts`
- Create: `src/fomo/history-client.ts`
- Create: `src/background/activity-sync.ts`
- Modify: `src/background/ingest-activity.ts`
- Modify: `src/storage/event-repository.ts`
- Modify: `src/messaging/protocol.ts`
- Modify: `src/messaging/guards.ts`
- Modify: `entrypoints/background.ts`
- Test: `tests/unit/history-client.test.ts`
- Test: `tests/unit/activity-sync.test.ts`
- Test: `tests/unit/popup-worker-boundary.test.ts`

- [ ] **Step 1: Write failing history-contract tests**

Parse `tests/fixtures/fomo-history-page.redacted.json` into:

```ts
export interface RecoveredActivityPage {
  activities: unknown[];
  nextCursor?: string;
  complete: boolean;
}
```

The parser must be strict about the captured envelope, bound a page to 200
activities, bound cursor length to 512 characters, and reject arbitrary URLs,
headers, or auth data in the result.

- [ ] **Step 2: Write failing client tests**

Use this dependency-injected API:

```ts
export interface FomoHistoryClientDependencies {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  buildRequest(cursor: ActivitySyncCursorV1): { url: URL; init: RequestInit };
}

export interface FomoHistoryClient {
  fetchPage(cursor: ActivitySyncCursorV1): Promise<RecoveredActivityPage>;
}
```

Tests assert the exact verified origin/path, method, credentials, cursor/window,
401/403 login-required, 429 retryable, non-2xx failure, malformed body, and
abort propagation. `buildRequest` must be implemented from the Task 1 evidence,
not invented in this plan.

- [ ] **Step 3: Write failing sync-state tests**

Define:

```ts
export type ActivitySyncReason = 'reconnect' | 'manual' | 'stale-panel-open';
export type ActivitySyncState =
  | { status: 'idle'; lastSucceededAt?: number }
  | { status: 'syncing'; reason: ActivitySyncReason; startedAt: number }
  | { status: 'updated'; added: number; finishedAt: number }
  | { status: 'current'; finishedAt: number }
  | { status: 'offline' | 'login-required' | 'recovery-unavailable' }
  | { status: 'failed'; retryable: boolean; finishedAt: number };
```

Cover cursor overlap, multi-page order, per-item rejection, duplicate replay,
partial failure without cursor skip, single-flight plus dirty follow-up,
reconnect trigger, manual trigger, and five-minute stale-open trigger.

- [ ] **Step 4: Verify RED**

```bash
corepack pnpm vitest run tests/unit/history-client.test.ts tests/unit/activity-sync.test.ts tests/unit/popup-worker-boundary.test.ts
```

Expected: FAIL because the client, state machine, and protocol do not exist.

- [ ] **Step 5: Implement canonical recovery ingest**

`ActivitySyncService` calls the verified client page by page and invokes the
existing `ActivityIngestor.ingest` for every recovered candidate. Count only
`status: 'inserted'` as added. Duplicates are successful convergence, not sync
errors. Advance the persisted cursor only after all items before that boundary
have been processed without a storage failure.

Add strict extension messages:

```ts
| { protocolVersion: 1; type: 'sync.request'; payload: { reason: ActivitySyncReason } }
| { protocolVersion: 1; type: 'sync.query' }
| { protocolVersion: 1; type: 'sync.changed' }
```

Only extension pages may request/query sync. `sync.changed` contains no event
payload and is emitted only by the worker.

- [ ] **Step 6: Wire triggers and fallback honestly**

When the verified adapter exists, bootstrap the coordinator and trigger it on
authenticated reconnect. Until evidence exists, compose an unavailable source
that returns `recovery-unavailable`; the refresh button must never claim it
contacted Fomo.

- [ ] **Step 7: Verify and commit**

```bash
corepack pnpm vitest run tests/unit/history-client.test.ts tests/unit/activity-sync.test.ts tests/unit/popup-worker-boundary.test.ts tests/unit/ingest-activity.test.ts tests/unit/messaging.test.ts
corepack pnpm typecheck
git add src/fomo/history-contract.ts src/fomo/history-client.ts src/background/activity-sync.ts src/background/ingest-activity.ts src/storage/event-repository.ts src/messaging entrypoints/background.ts tests
git commit -m "feat: recover missed Fomo activity"
```

### Task 5: Add manual refresh and reconnect synchronization UI

**Files:**
- Create: `src/sidepanel/RefreshButton.tsx`
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `src/popup/popup-io.ts`
- Modify: `entrypoints/sidepanel/sidepanel.css`
- Test: `tests/unit/RefreshButton.test.tsx`
- Test: `tests/unit/SidePanelApp.test.tsx`
- Test: `tests/unit/HistoryFeed.test.tsx`

- [ ] **Step 1: Write failing refresh-state tests**

Assert icon/tooltip/status behavior for `idle`, `syncing`, `updated`, `current`,
`offline`, `login-required`, `recovery-unavailable`, and `failed`. The button is
disabled only when syncing/offline/login-required and never clears rendered
history.

- [ ] **Step 2: Write failing trigger and race tests**

Cover:

- Click sends one `sync.request { reason: 'manual' }`.
- Connected transition triggers reconnect sync once.
- Connected panel with last success older than five minutes triggers
  `stale-panel-open` once.
- `sync.changed` re-queries sync state and existing `events.changed` refreshes
  history.
- Rapid clicks and reconnect coalesce.
- Old query completions cannot overwrite a newer state; unmount removes all
  listeners/timers.

- [ ] **Step 3: Verify RED**

```bash
corepack pnpm vitest run tests/unit/RefreshButton.test.tsx tests/unit/SidePanelApp.test.tsx tests/unit/HistoryFeed.test.tsx
```

- [ ] **Step 4: Implement the header control**

Add builders/clients:

```ts
requestActivitySync(runtime, reason): Promise<ActivitySyncState>
queryActivitySync(runtime): Promise<ActivitySyncState>
```

Use a local SVG refresh icon with `aria-label` and `title`. Expose localized
live status through `role="status"`. Keep existing rows mounted during sync and
failure. A successful recovery relies on `events.changed`; do not inject rows
directly into React state.

- [ ] **Step 5: Verify and commit**

```bash
corepack pnpm vitest run tests/unit/RefreshButton.test.tsx tests/unit/SidePanelApp.test.tsx tests/unit/HistoryFeed.test.tsx tests/unit/popup-worker-boundary.test.ts
corepack pnpm typecheck
corepack pnpm build
git add src/sidepanel src/popup/popup-io.ts entrypoints/sidepanel/sidepanel.css tests
git commit -m "feat: add activity refresh controls"
```

### Task 6: Migrate settings and localize the full extension UI

**Files:**
- Create: `src/i18n/catalog.ts`
- Create: `src/i18n/LocaleProvider.tsx`
- Modify: `src/domain/settings.ts`
- Modify: `src/storage/local-preferences.ts`
- Modify: `entrypoints/sidepanel/App.tsx`
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: all user-visible components under `src/sidepanel/`, `src/popup/`, and `src/overlay/`
- Modify: `entrypoints/trading-overlay.content/index.ts`
- Test: `tests/unit/i18n-catalog.test.ts`
- Test: `tests/unit/LocaleProvider.test.tsx`
- Test: `tests/unit/local-preferences.test.ts`
- Modify: component tests containing visible English assertions

- [ ] **Step 1: Write failing V1-to-V2 migration tests**

Define:

```ts
export type UiLocale = 'en' | 'zh-CN';
export type TranslationTarget = 'auto' | 'zh' | 'en';

export interface LocalSettingsV2 {
  schemaVersion: 2;
  notifications: LocalSettingsV1['notifications'];
  metrics: LocalSettingsV1['metrics'];
  filters: LocalSettingsV1['filters'];
  uiLocale: UiLocale;
  opinionTranslation: {
    enabled: boolean;
    targetLanguage: TranslationTarget;
  };
}
```

V1 migration must preserve every existing field and initialize locale through
an injected browser-locale resolver. Defaults: translation enabled/auto.
Because V1 may contain muted `monad`, migration drops only muted-chain values
outside the new six-chain union and preserves every still-supported muted
chain. Corrupt V2 falls back without deleting annotation storage.

- [ ] **Step 2: Write failing typed-catalog tests**

Expose:

```ts
export type MessageKey = keyof typeof EN_MESSAGES;
export function translate(
  locale: UiLocale,
  key: MessageKey,
  values?: Readonly<Record<string, string | number>>,
): string;
```

Assert English and Chinese catalogs have identical keys, no empty values, no
unresolved `{placeholder}`, safe text interpolation, and coverage for every
visible state in Side Panel, Settings, diagnostics, Toasts, CA copy, refresh,
and translation UI.

- [ ] **Step 3: Write failing locale-provider tests**

Assert first-run browser locale resolution, stored override, immediate
`EN / 中文` switching without reload, restart persistence, storage-change
propagation, and independence from `opinionTranslation.targetLanguage`.

- [ ] **Step 4: Verify RED**

```bash
corepack pnpm vitest run tests/unit/i18n-catalog.test.ts tests/unit/LocaleProvider.test.tsx tests/unit/local-preferences.test.ts
```

- [ ] **Step 5: Implement settings migration and typed locale context**

Persist V2 under `settings.v2`; read V2 first, otherwise migrate `settings.v1`
and write V2 once. Do not delete V1 in this release so rollback remains
recoverable. `LocaleProvider` owns only locale/message lookup; it does not own
translation services.

- [ ] **Step 6: Move every extension-owned string behind message keys**

Add the compact header segmented control. Replace literal English in Side Panel,
Settings, diagnostics, Toasts, action labels, filter chips, empty/error states,
accessibility labels, and fallback UI. Preserve dynamic trader/token/address
values unchanged and render interpolation as React text.

- [ ] **Step 7: Verify and commit**

```bash
corepack pnpm vitest run tests/unit/i18n-catalog.test.ts tests/unit/LocaleProvider.test.tsx tests/unit/local-preferences.test.ts tests/unit/SidePanelApp.test.tsx tests/unit/SettingsPanel.test.tsx tests/unit/ToastStack.test.tsx
corepack pnpm typecheck
corepack pnpm build
git add src/i18n src/domain/settings.ts src/storage/local-preferences.ts src/sidepanel src/popup src/overlay entrypoints tests/unit
git commit -m "feat: localize extension UI"
```

### Task 7: Add automatic on-device opinion translation

**Files:**
- Create: `src/translation/browser-translation.ts`
- Create: `src/translation/opinion-translation.ts`
- Create: `src/translation/use-opinion-translation.ts`
- Create: `src/sidepanel/TranslatedOpinion.tsx`
- Modify: `src/popup/EventCard.tsx`
- Modify: `src/overlay/ToastStack.tsx`
- Modify: `src/popup/SettingsPanel.tsx`
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `entrypoints/sidepanel/App.tsx`
- Modify: `wxt.config.ts`
- Test: `tests/unit/browser-translation.test.ts`
- Test: `tests/unit/opinion-translation.test.ts`
- Test: `tests/unit/TranslatedOpinion.test.tsx`
- Modify: `tests/unit/HistoryFeed.test.tsx`
- Modify: `tests/unit/ToastStack.test.tsx`
- Modify: `tests/unit/manifest-config.test.ts`

- [ ] **Step 1: Write failing browser-boundary tests**

Use dependency interfaces rather than untyped globals:

```ts
export type ModelAvailability =
  | 'available'
  | 'downloadable'
  | 'downloading'
  | 'unavailable';

export interface BrowserTranslationApi {
  detect(text: string): Promise<{ language: string; confidence: number }>;
  availability(sourceLanguage: string, targetLanguage: string): Promise<ModelAvailability>;
  create(sourceLanguage: string, targetLanguage: string): Promise<{
    translate(text: string): Promise<string>;
    destroy(): void;
  }>;
}
```

Tests cover missing API, already available, model download progress, user
activation required, unsupported pair, translation rejection, and session
destruction.

- [ ] **Step 2: Write failing coordinator/cache tests**

Define:

```ts
export type OpinionTranslationResult =
  | { status: 'unchanged'; original: string }
  | { status: 'translated'; original: string; translated: string }
  | { status: 'activation-required'; original: string }
  | { status: 'unavailable' | 'failed'; original: string };
```

Test target `auto` resolution from browser language, same-language bypass,
SHA-256 cache key, maximum 200-entry LRU, concurrent request coalescing,
latest-wins preference changes, bounded source length, and no persistence or
runtime messaging.

- [ ] **Step 3: Write failing component tests**

For a thesis card, assert original-first rendering, localized translating state,
automatic translated-primary rendering, `View original` toggle, activation
action only when model creation requires it, failure fallback, XSS-safe text,
and unmount cleanup. Non-thesis cards never invoke detection.

- [ ] **Step 4: Verify RED**

```bash
corepack pnpm vitest run tests/unit/browser-translation.test.ts tests/unit/opinion-translation.test.ts tests/unit/TranslatedOpinion.test.tsx tests/unit/HistoryFeed.test.tsx tests/unit/ToastStack.test.tsx tests/unit/manifest-config.test.ts
```

- [ ] **Step 5: Implement browser adapter and coordinator**

Feature-detect `LanguageDetector` and `Translator`. Normalize BCP-47 tags to
supported base languages. Keep detection, translator sessions, text, cache,
and results inside the Side Panel process. Hash the original text before using
it in a cache key. Destroy sessions on eviction or provider unmount.

- [ ] **Step 6: Integrate automatic UI behavior**

Translate eligible visible thesis cards automatically when the pair is
available. If download requires user activation, show one header-level enable
action; after activation, visible cards retry automatically. Settings contains
translation enable and target controls independently from the UI-locale switch.

Toasts must never wait for translation. They may show the original opinion only;
the Side Panel owns automatic translated history to avoid duplicating model
sessions in content-script worlds.

- [ ] **Step 7: Raise Chrome version and verify privacy boundary**

Set:

```ts
minimum_chrome_version: '138'
```

Assert manifest permissions and host permissions are otherwise unchanged. Add a
static boundary test that `src/translation/**` imports neither popup runtime
messaging nor storage repositories.

- [ ] **Step 8: Verify and commit**

```bash
corepack pnpm vitest run tests/unit/browser-translation.test.ts tests/unit/opinion-translation.test.ts tests/unit/TranslatedOpinion.test.tsx tests/unit/HistoryFeed.test.tsx tests/unit/ToastStack.test.tsx tests/unit/manifest-config.test.ts
corepack pnpm typecheck
corepack pnpm build
git add src/translation src/sidepanel src/popup/EventCard.tsx src/popup/SettingsPanel.tsx src/overlay/ToastStack.tsx entrypoints/sidepanel/App.tsx wxt.config.ts tests/unit
git commit -m "feat: translate opinions on device"
```

### Task 8: Enable verified trader metrics without blocking activity

**Depends on:** Task 1 metrics evidence.

**Files:**
- Modify: `src/fomo/enrichment-client.ts`
- Modify: `entrypoints/background.ts`
- Replace: `tests/fixtures/fomo-leaderboard-7d.json` with the verified redacted fixture or remove it
- Test: `tests/unit/enrichment-client.test.ts`
- Test: `tests/unit/ingest-activity.test.ts`
- Test: `tests/unit/popup-worker-boundary.test.ts`

- [ ] **Step 1: Write failing verified-response tests**

Use only JSON paths documented in `fomo-metrics-contract.md`. Assert explicit
seven-day PnL/win rate, followers, response bounds, 401/403, 429, malformed
values, lifetime-only rejection, abort, and cache TTL.

- [ ] **Step 2: Verify RED**

```bash
corepack pnpm vitest run tests/unit/enrichment-client.test.ts tests/unit/ingest-activity.test.ts tests/unit/popup-worker-boundary.test.ts
```

- [ ] **Step 3: Enable the production adapter**

Replace `unavailableMetricSource` only when the verified fixture passes. Metrics
remain enrichment: timeout, auth failure, malformed body, or server failure
returns an unavailable snapshot and never rejects/pushes back the canonical
activity ingest or Toast broadcast.

- [ ] **Step 4: Verify and commit**

```bash
corepack pnpm vitest run tests/unit/enrichment-client.test.ts tests/unit/ingest-activity.test.ts tests/unit/popup-worker-boundary.test.ts tests/unit/SettingsPanel.test.tsx
corepack pnpm typecheck
git add src/fomo/enrichment-client.ts entrypoints/background.ts tests/fixtures tests/unit
git commit -m "feat: enable verified Fomo metrics"
```

### Task 9: Complete integration, E2E, documentation, and release gates

**Files:**
- Modify: `tests/e2e/fixture-server.ts`
- Modify: `tests/e2e/live-feed.spec.ts`
- Modify: `tests/e2e/fixtures/fomo-page.html`
- Modify: `docs/manual-testing.zh-CN.md`
- Modify: `docs/development.md`
- Modify: `docs/privacy.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-21-feed-recovery-translation-i18n.md`

- [ ] **Step 1: Extend the deterministic fixture server**

Provide authenticated-history fixtures with pagination, gap events, duplicates,
401/403, 429, malformed item, and delayed response controls. Add translation API
test doubles for available, downloadable/activation-required, and unavailable
states without networking.

- [ ] **Step 2: Write real Side Panel recovery E2E**

Verify:

1. Start connected with two rows.
2. Disconnect the fixture socket.
3. Add two server-history events during the gap.
4. Reconnect without reloading the panel.
5. Observe four unique rows and no duplicate Toast.
6. Add another server-only event, click Refresh, observe five rows plus
   `Updated` state.
7. Exercise no-new-events, offline, login-required, 429/failure, and retry.

No test may call `panel.reload()` or use fixed sleeps as synchronization.
Synchronize through UI state or bounded diagnostic counters.

- [ ] **Step 3: Add six-chain, translation, and locale E2E**

At 280px and a normal width, verify all six verified badge labels, address-copy
rules, and Unknown non-interactivity. Verify an English opinion automatically
renders Chinese with original toggle using the local API double. Verify the
unavailable model preserves original. Switch `EN / 中文`, assert interface text
changes immediately, and assert the translation target/data do not change.

- [ ] **Step 4: Update documentation and privacy disclosures**

Document Chrome 138 requirement, possible local language-pack download,
translation activation/unavailable states, independent UI/translation settings,
refresh semantics, recovery evidence gate, six-chain scope, unknown-ID
diagnostics, and the fact that translation text is not remotely transmitted or
persisted.

- [ ] **Step 5: Run the automated release gate**

```bash
CI=true corepack pnpm check
CI=true corepack pnpm test:e2e
git diff --check
git status --short
```

Expected: all unit/integration tests, typecheck, production build, and Chromium
E2E pass; no unexpected worktree changes remain.

- [ ] **Step 6: Run authenticated manual release checkpoint**

Using Chrome Stable 138+ and a logged-in Fomo account, execute every checkpoint
in specification section 15. Do not complete this step if any required chain ID,
history endpoint, Robinhood address format, metrics period, reconnect gap, or
local model behavior remains unverified.

- [ ] **Step 7: Mark the plan complete and commit**

Only after Steps 5 and 6 pass, mark every genuinely completed checkbox and run:

```bash
git add tests/e2e docs README.md
git commit -m "test: verify feed recovery and localization"
```

## Final review checklist

Before integration, dispatch an independent specification reviewer and then a
code-quality reviewer. Both must inspect the full range from the design-spec
commit to the final implementation head. Release is blocked by any open
Critical or Important finding, any guessed Fomo contract, any translation
network request, or any failed authenticated checkpoint.
