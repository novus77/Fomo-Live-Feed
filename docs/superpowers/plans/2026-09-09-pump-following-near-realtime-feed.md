# Pump Following Near-Real-Time Feed Implementation Plan

> **For Codex:** Execute this plan task by task with the `executing-plans` workflow. Use test-driven development for every behavior change. Do not create Git commits unless the user explicitly authorizes them; use the listed verification commands as local checkpoints.

**Goal:** Add Pump.fun followed-trader buy/sell activity to the existing Fomo feed through a page-owned one-second polling loop with bounded catch-up, source filtering, deduplication, and honest connection status.

**Architecture:** A MAIN-world Pump collector performs authenticated same-origin fetches without inspecting credentials. An isolated bridge accepts only a strict, bounded Pump envelope and forwards it to the background worker. The worker owns leader leases, watermarks, recovery state, normalization, deduplication, persistence, sound decisions, and broadcasts. Side panel, floating window, and document PiP continue to read one repository.

**Tech Stack:** TypeScript, WXT Manifest V3 content scripts, React 19, Zod 4, Dexie 4, Vitest, Testing Library, Playwright.

---

## Global invariants

- Never read, forward, persist, or log cookies, request headers, tokens, signatures, account addresses, raw Pump responses, or cursor-bearing request URLs.
- Initial Pump data establishes a watermark only. It is never displayed.
- Only a newly inserted live buy may trigger sound. Recovered, initial, duplicate, merged, sell, thesis, and transfer events are silent.
- Pump failures never interrupt Fomo capture or rendering.
- At most one Pump request is in flight and one Pump tab owns the polling lease.
- Every bridge and runtime boundary validates exact origin, protocol version, epoch, message type, length limits, and numeric limits.

## Task 1: Lock the Pump response contract with synthetic fixtures

**Files:**

- Modify: `docs/evidence/pump-realtime-contract.md`
- Create: `tests/fixtures/pump/following-trades-page.json`
- Create: `tests/unit/pump-raw-schema.test.ts`
- Create: `src/pump/raw-schema.ts`

**Step 1: Write failing schema tests**

Cover a valid page, optional image fields, a nullable cursor, invalid top-level envelope, more than 100 items, cursor over 4,096 characters, strings over their field bounds, invalid timestamps, non-finite/negative/over-`1e15` financial fields, and the batch failure threshold of at least three and at least 20 percent.

Run:

```bash
pnpm vitest run tests/unit/pump-raw-schema.test.ts
```

Expected: FAIL because `src/pump/raw-schema.ts` does not exist.

**Step 2: Add the strict raw schemas**

Expose these public contracts:

```ts
export const MAX_PUMP_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_PUMP_PAGE_ITEMS = 100;
export interface PumpPageParseResult {
  accepted: RawPumpTrade[];
  rejectedCount: number;
  nextCursor?: string;
}
export function parsePumpTradePage(payload: unknown): PumpPageParseResult;
```

The top-level object must contain only a bounded `items` array and nullable/optional bounded `nextCursor`. Parse items independently and throw `PumpProtocolError` when the top-level shape fails or the critical item rejection threshold is reached.

**Step 3: Replace captured values with a synthetic fixture**

The fixture must retain only the confirmed field names and representative primitive values. All identities, addresses, transaction hashes, and URLs must be invented.

**Step 4: Update the evidence gate**

Change the evidence status from blocked to approved for the authenticated HTTP near-real-time path, while preserving the warning that Pump publishes no one-second SLA and NATS position messages are not trades.

**Step 5: Verify the checkpoint**

```bash
pnpm vitest run tests/unit/pump-raw-schema.test.ts
pnpm typecheck
```

Expected: PASS.

## Task 2: Introduce a backward-compatible unified event model

**Files:**

- Modify: `src/domain/activity.ts`
- Modify: `src/domain/event-validation.ts`
- Modify: `src/storage/database.ts`
- Modify: `src/storage/event-repository.ts`
- Modify: `tests/unit/event-validation.test.ts`
- Modify: `tests/unit/event-repository.test.ts`
- Create: `tests/unit/database-v3-migration.test.ts`

**Step 1: Write failing V2 and migration tests**

Prove that V1 Fomo rows still load, V2 Pump rows require `sources`, a source reference can carry a transaction hash, optional market cap stays optional, invalid values are rejected, and database version 3 upgrades old rows without changing their IDs or read state.

**Step 2: Add the event contracts**

```ts
export interface EventSourceReference {
  source: ActivitySource;
  sourceEventId?: string;
  sourceTradeId?: string;
}

export interface TradeEventV2 {
  schemaVersion: 2;
  id: string;
  sources: EventSourceReference[];
  traderId: string;
  traderHandle: string;
  traderName?: string;
  traderAvatarUrl?: string;
  chain: ChainKey;
  networkId?: number;
  tokenAddress: string;
  tokenSymbol: string;
  tokenImageUrl?: string;
  action: ActivityAction;
  usdAmount?: number;
  marketCap?: number;
  price?: number;
  thesis?: string;
  occurredAt: number;
  receivedAt: number;
  readAt?: number;
  delivery: 'live' | 'recovered';
}

export type TradeEvent = TradeEventV1 | TradeEventV2;
```

Add selectors `getEventSources`, `getPrimarySource`, and `isLiveEvent` so UI and sound code never branch directly on schema version.

**Step 3: Add database version 3**

Keep existing indexes stable and migrate each valid V1 row to V2 in place with `sources: [{ source: 'fomo', ... }]` and `delivery: 'live'`. Invalid historical rows remain quarantined by existing validation rather than being guessed.

**Step 4: Generalize repository types**

Use `TradeEvent` throughout repository reads and writes. Add an atomic upsert outcome:

```ts
export type EventWriteResult = 'inserted' | 'merged' | 'duplicate';
export function upsert(event: TradeEventV2): Promise<EventWriteResult>;
```

Merging may add a missing source reference and fill absent presentation fields, but must not overwrite known financial values with different values.

**Step 5: Verify the checkpoint**

```bash
pnpm vitest run tests/unit/event-validation.test.ts tests/unit/event-repository.test.ts tests/unit/database-v3-migration.test.ts
pnpm typecheck
```

Expected: PASS.

## Task 3: Normalize Pump trades and deduplicate cross-source events

**Files:**

- Create: `src/pump/network-map.ts`
- Create: `src/pump/normalize.ts`
- Create: `src/domain/event-deduplication.ts`
- Create: `tests/unit/pump-normalize.test.ts`
- Create: `tests/unit/event-deduplication.test.ts`

**Step 1: Write failing normalization tests**

Cover confirmed Solana numeric chain ID `1399811149`, unknown chain fallback, address preservation, safe HTTPS image normalization, buy/sell mapping, `pump:<chainId>:<tx>` IDs, event market cap, and missing optional fields.

**Step 2: Implement normalization**

```ts
export function mapPumpChainId(chainId: number): ChainKey;
export function normalizePumpTrade(
  raw: RawPumpTrade,
  receivedAt: number,
  delivery: 'live' | 'recovered',
): TradeEventV2;
```

Only map chain IDs supported by captured evidence. Unknown numeric IDs remain `unknown`.

**Step 3: Implement conservative fingerprints**

```ts
export function exactTransactionKey(event: TradeEventV2): string | undefined;
export function conservativeTradeFingerprint(event: TradeEventV2): string | undefined;
export function canMergeEvents(left: TradeEventV2, right: TradeEventV2): boolean;
```

Prefer chain plus transaction hash. The fallback requires exact trader identity, chain, token address, action, amount, and a narrow occurrence-time bucket. Missing or conflicting required fields must return no merge.

**Step 4: Verify the checkpoint**

```bash
pnpm vitest run tests/unit/pump-normalize.test.ts tests/unit/event-deduplication.test.ts
pnpm typecheck
```

Expected: PASS.

## Task 4: Build the deterministic polling, watermark, catch-up, and backoff core

**Files:**

- Create: `src/pump/polling-types.ts`
- Create: `src/pump/watermark.ts`
- Create: `src/pump/backoff.ts`
- Create: `src/pump/catch-up.ts`
- Create: `src/pump/polling-machine.ts`
- Create: `tests/unit/pump-watermark.test.ts`
- Create: `tests/unit/pump-backoff.test.ts`
- Create: `tests/unit/pump-catch-up.test.ts`
- Create: `tests/unit/pump-polling-machine.test.ts`

**Step 1: Write state-machine tests first**

Use injected clock, timer, random, and request functions. Test one-second request-start cadence, no overlap, four-second timeout, initial watermark without emission, normal live emission, gap over three seconds, offline recovery, five-page yield, ascending recovered output, watermark discovery, cursor loops, 1,000-event and 24-hour bounds.

**Step 2: Add bounded recent-key state**

```ts
export interface PumpWatermarkState {
  accountSessionId: string;
  epoch: number;
  watermark?: string;
  recentKeys: string[];
}
export class PumpRecentKeys {
  constructor(seed?: readonly string[], capacity?: number);
  has(key: string): boolean;
  add(key: string): void;
  values(): string[];
}
```

Capacity defaults to 2,048 and eviction is deterministic FIFO.

**Step 3: Add backoff policy**

```ts
export function nextPumpDelay(input: {
  failure: 'rate-limit' | 'timeout' | 'network' | 'server';
  level: number;
  retryAfterMs?: number;
  random: number;
}): { delayMs: number; level: number };
```

Use 3/5/10/30/60 seconds for rate limits, exponential bounded delays for transport/server failures, ±20 percent jitter, and never schedule before a valid server minimum. Three consecutive successes reduce one level.

**Step 4: Add catch-up reducer**

Keep cursor, visited cursors, old watermark, examined count, oldest accepted time, and buffered candidates in explicit state. Return `continue`, `yield`, `complete`, or `possible-gap`; never hide a boundary stop as successful completion.

**Step 5: Add the polling machine**

The machine owns no browser globals. It accepts commands (`leaderGranted`, `leaderRevoked`, `online`, `offline`, `tick`, `response`, `failure`) and emits effects (`schedule`, `request`, `publish`, `persistState`, `reportStatus`). This makes suspension and retry behavior unit-testable.

**Step 6: Verify the checkpoint**

```bash
pnpm vitest run tests/unit/pump-watermark.test.ts tests/unit/pump-backoff.test.ts tests/unit/pump-catch-up.test.ts tests/unit/pump-polling-machine.test.ts
pnpm typecheck
```

Expected: PASS.

## Task 5: Add Pump MAIN-world collector and isolated bridge

**Files:**

- Modify: `src/messaging/protocol.ts`
- Modify: `src/messaging/guards.ts`
- Create: `src/pump/window-protocol.ts`
- Create: `src/pump/http-collector.ts`
- Create: `src/pump/bridge.ts`
- Create: `entrypoints/pump-interceptor.content.ts`
- Create: `entrypoints/pump-bridge.content.ts`
- Create: `tests/unit/pump-http-collector.test.ts`
- Create: `tests/integration/pump-bridge.test.ts`
- Modify: `tests/unit/messaging-guards.test.ts`
- Modify: `tests/unit/manifest.test.ts`

**Step 1: Write boundary tests**

Reject wrong source windows, non-Pump origins, namespaces, versions, epochs, commands, payload sizes, repeated cursors, and stale leaders. Prove that outgoing messages contain only parsed trade fields, cursor, epoch, result classification, status code class, and timing counters.

**Step 2: Extend the closed runtime protocol**

Add strictly validated message types:

```ts
type PumpRuntimeMessage =
  | { type: 'pump.tabReady'; payload: { at: number } }
  | { type: 'pump.lease'; payload: { granted: boolean; epoch: number; expiresAt: number } }
  | { type: 'pump.batch'; payload: PumpBatchPayload }
  | { type: 'pump.status'; payload: PumpStatusPayload }
  | { type: 'pump.pageHidden'; payload: { epoch: number; at: number } };
```

Update sender guards so Pump page messages are accepted only from exact supported Pump HTTPS origins and worker-only messages remain outbound-only.

**Step 3: Implement the page collector**

The MAIN-world collector owns the same-origin `fetch`, request timeout, cadence, pagination, and sanitized window messages. It calls only the fixed path `/following-positions/alerts` with fixed query parameters plus a validated cursor. It does not monkey-patch global fetch and never observes request headers.

**Step 4: Implement the isolated bridge**

The bridge validates the Pump envelope before forwarding it. It reports page readiness/pagehide and applies a worker-issued lease command only when the command epoch is newer than its current epoch.

**Step 5: Register exact content script matches**

Use the official Pump HTTPS origins already proven by the browser investigation. Do not request broad host permissions or `<all_urls>`.

**Step 6: Verify the checkpoint**

```bash
pnpm vitest run tests/unit/pump-http-collector.test.ts tests/integration/pump-bridge.test.ts tests/unit/messaging-guards.test.ts tests/unit/manifest.test.ts
pnpm typecheck
```

Expected: PASS.

## Task 6: Add background leader lease, session persistence, and ingestion

**Files:**

- Modify: `entrypoints/background.ts`
- Create: `src/background/pump-leader.ts`
- Create: `src/background/pump-session-store.ts`
- Create: `src/background/pump-ingestion.ts`
- Create: `tests/unit/pump-leader.test.ts`
- Create: `tests/unit/pump-session-store.test.ts`
- Create: `tests/integration/pump-ingestion.test.ts`
- Modify: `tests/unit/buy-sound.test.ts`

**Step 1: Write leader and stale-epoch tests**

Prove one leader across multiple tabs, lease renewal, deterministic takeover, closed-tab removal, pagehide handling, stale-epoch batch rejection, worker restart restoration, account-session replacement, and a maximum tracked-tab bound.

**Step 2: Implement the lease coordinator**

```ts
export interface PumpLease {
  tabId: number;
  epoch: number;
  expiresAt: number;
}
export class PumpLeaderCoordinator {
  register(tabId: number, at: number): PumpLeaseDecision;
  renew(tabId: number, epoch: number, at: number): PumpLeaseDecision;
  remove(tabId: number, at: number): PumpLeaseDecision;
  restore(openTabIds: ReadonlySet<number>, at: number): PumpLeaseDecision;
}
```

Persist only bounded lease metadata and the session watermark in `chrome.storage.session`.

**Step 3: Implement ingestion**

Normalize each accepted item, reject stale epoch/session/connection-time rows, write through repository upsert, update counters, and broadcast once per inserted or merged change. Return a structured batch acknowledgement without identities.

**Step 4: Enforce sound classification**

Sound requires `writeResult === 'inserted'`, `delivery === 'live'`, and `action === 'buy'`. Add regression tests for recovered buys and cross-source merges.

**Step 5: Wire background lifecycle**

Handle Pump protocol messages in the existing exhaustive switch. Re-seed leases only from currently open Pump tabs, revoke on tab removal, and keep every Fomo connection and sync branch unchanged.

**Step 6: Verify the checkpoint**

```bash
pnpm vitest run tests/unit/pump-leader.test.ts tests/unit/pump-session-store.test.ts tests/integration/pump-ingestion.test.ts tests/unit/buy-sound.test.ts
pnpm typecheck
```

Expected: PASS.

## Task 7: Finish source-aware query, projection, and navigation

**Files:**

- Modify: `src/popup/event-query.ts`
- Modify: `src/sidepanel/use-event-feed.ts`
- Modify: `src/sidepanel/FeedFilterPopover.tsx`
- Create: `src/navigation/pump-links.ts`
- Modify: `src/navigation/open-token.ts`
- Modify: `tests/unit/event-query.test.ts`
- Modify: `tests/unit/FeedFilterPopover.test.tsx`
- Create: `tests/unit/pump-links.test.ts`

**Step 1: Add failing source-filter tests**

All includes every event, Fomo includes rows whose source set contains Fomo, and Pump includes rows whose source set contains Pump. A dual-source row remains one row. Its displayed badges are projected to both for All, Fomo-only for Fomo, and Pump-only for Pump.

**Step 2: Complete buy-amount interval behavior**

Keep the already implemented inclusive lower/upper bounds. Apply them only to buy rows; sell/thesis/transfer behavior must match the approved filter semantics. Empty input means unbounded and malformed input must not mutate saved preferences.

**Step 3: Add Pump token navigation**

Generate only allowlisted HTTPS Pump URLs from validated token addresses. For a merged event, navigation follows the currently projected source; All uses the event's primary source deterministically.

**Step 4: Verify the checkpoint**

```bash
pnpm vitest run tests/unit/event-query.test.ts tests/unit/FeedFilterPopover.test.tsx tests/unit/pump-links.test.ts
pnpm typecheck
```

Expected: PASS.

## Task 8: Integrate compact source UI and Pump status

**Files:**

- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `src/sidepanel/EventCard.tsx`
- Modify: `src/sidepanel/SourceIcon.tsx`
- Create: `src/sidepanel/SourceBadge.tsx`
- Create: `src/sidepanel/PumpStatusIndicator.tsx`
- Modify: `src/sidepanel/sidepanel.css`
- Modify: `src/i18n/catalog.ts`
- Modify: `tests/unit/EventCard.test.tsx`
- Create: `tests/unit/SourceBadge.test.tsx`
- Create: `tests/unit/PumpStatusIndicator.test.tsx`
- Modify: `tests/unit/SidePanelApp.test.tsx`

**Step 1: Write UI tests before changing markup**

Cover projected badges, accessible names/tooltips, correct icons, no extra card row, exact three-row order, source filter selection, Pump degraded states, and Fomo continuity.

**Step 2: Render the approved compact unified-feed shell and three-row card**

Use the approved `designs/pump-unified-feed-prototype` as the visual source of truth for the header, platform status icons, quick action/source filters, detailed filter popover, and event-card treatment. Keep the production token icon/name layout intact. Project source icons onto the avatar and identity row, showing both only for merged events in the All-source view and showing the selected source in single-source views. Preserve inline note, time beside username, address alignment, copy action, chain badge, independent amount styling, and optional `MC:`.

**Step 3: Render compact status**

Support `live`, `catching-up`, `delayed`, `rate-limited`, `authentication-required`, `protocol-incompatible`, `possible-gap`, and `disconnected`. Expose detail through tooltip or existing status panel, not another permanent row.

**Step 4: Verify density and accessibility**

Add CSS assertions where stable and verify the real built extension at 320 px and 280 px widths. Cards must remain at or below 92 px for standard trade rows, at least six complete cards must remain visible at 320 × 720, and the document must not overflow horizontally. Keyboard focus and selected states must remain visible in both themes.

**Step 5: Verify the checkpoint**

```bash
pnpm vitest run tests/unit/EventCard.test.tsx tests/unit/SourceBadge.test.tsx tests/unit/PumpStatusIndicator.test.tsx tests/unit/SidePanelApp.test.tsx
pnpm typecheck
```

Expected: PASS.

## Task 9: End-to-end recovery, diagnostics, build, and release verification

**Files:**

- Create: `tests/e2e/pump-unified-feed.spec.ts`
- Modify: `src/background/diagnostics.ts`
- Modify: `tests/unit/diagnostics.test.ts`
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/evidence/pump-realtime-contract.md`

**Step 1: Add redacted end-to-end scenarios**

Use a local synthetic Pump page to verify initial watermark silence, new live buy insertion and sound, recovered insertion without sound, source filtering, dual-source projection, leader takeover, stale-epoch rejection, 429 backoff, 401 stop, malformed-200 stop, and Fomo continuity.

**Step 2: Add bounded diagnostics**

Store only counters, closed status codes, timestamps, backoff level, catch-up page count, possible-gap count, and schema version. Add tests that account/user/token/transaction/cursor fields cannot be recorded.

**Step 3: Update product documentation**

Describe Pump as near-real-time with automatic recovery. State that only post-connection trades are accepted, market cap comes from the event, and one-second background delivery is not guaranteed by Pump or Chrome.

**Step 4: Run full verification**

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm test:e2e
```

Expected: all commands PASS.

**Step 5: Inspect the production package**

```bash
pnpm package:local
```

Verify the manifest contains only intended Pump/Fomo matches, no broad host permission, all source icons exist, the zip opens, and no synthetic fixture or sensitive evidence value is bundled.

**Step 6: Manual authenticated smoke test**

Load the unpacked build, open one logged-in Pump tab and one Fomo tab, establish an empty Pump watermark, observe a post-connection followed-trader trade, switch All/Fomo/Pump filters, switch side panel/floating/PiP surfaces, background and restore the Pump tab, and verify recovery/status/sound behavior. Record only counts, states, and timing—not identities or payloads.

## Final completion gate

The feature is complete only when all automated checks pass, the authenticated smoke test confirms a post-connection Pump event, Fomo continues during Pump failure, initial/recovered events remain silent, and the production package passes manifest and privacy inspection.
