# Pump Following Live Feed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add zero-credential Pump Following live capture to the existing unified Fomo feed, with conservative cross-source deduplication and a compact three-row source-aware UI.

**Architecture:** A Pump MAIN-world observer mirrors the existing Fomo interceptor boundary, while an isolated bridge validates Pump-origin envelopes and forwards bounded messages to the worker. Pump normalization, Following membership, connection state, and source merging remain separate modules before converging on the canonical repository and shared side-panel surfaces.

**Tech Stack:** TypeScript 5.9, React 19, WXT 0.21, Zod 4, Dexie 4, Vitest 3, Testing Library, Playwright.

**UI companion plan:** After Tasks 1–7 establish the verified Pump transport and
canonical multi-source event model, execute
`docs/superpowers/plans/2026-09-09-pump-unified-feed-ui.md` for the approved
compact toolbar, exact selected-source badge projection, official source
artwork, and raw-USD buy-amount range. That companion plan supersedes the UI
details in Task 8 where they differ.

---

## File map

- Create `src/pump/raw-schema.ts`: bounded Pump Following and trade schemas.
- Create `src/pump/network-map.ts`: confirmed Pump chain mapping.
- Create `src/pump/normalize.ts`: Pump raw-to-canonical conversion.
- Create `src/pump/realtime-observer.ts`: MAIN-world transport observer.
- Create `src/pump/bridge.ts`: exact-origin isolated-world bridge.
- Create `src/pump/following-set.ts`: current followed-trader membership.
- Create `src/domain/event-deduplication.ts`: stablecoin-leg and cross-source merge rules.
- Create `src/navigation/pump-links.ts`: validated Pump profile/token links.
- Create `src/sidepanel/SourceBadge.tsx`: single/dual source icon group.
- Create `src/sidepanel/SourceStatus.tsx`: independent connection indicators.
- Create `entrypoints/pump-interceptor.content.ts`: Pump MAIN-world entrypoint.
- Create `entrypoints/pump-bridge.content.ts`: Pump isolated-world entrypoint.
- Modify `src/domain/activity.ts` and `src/domain/event-validation.ts`: versioned multi-source event.
- Modify `src/storage/database.ts` and `src/storage/event-repository.ts`: migration and merge-aware upsert.
- Modify `src/messaging/protocol.ts` and `src/messaging/guards.ts`: Pump messages and origins.
- Modify `src/background/ingest-activity.ts`, `src/background/connection-state.ts`, and `entrypoints/background.ts`: source-aware ingestion and status.
- Modify `src/popup/event-query.ts` and `src/popup/use-event-feed.ts`: source filtering.
- Modify `src/popup/EventCard.tsx`, `src/sidepanel/FeedFilterPopover.tsx`, `src/sidepanel/SidePanelApp.tsx`, and `entrypoints/sidepanel/sidepanel.css`: compact three-row UI.
- Modify `src/background/buy-sound.ts`: one sound per canonical event.
- Modify `wxt.config.ts` and `src/i18n/catalog.ts`: Pump permissions and copy.
- Add focused unit/integration fixtures and extend `tests/e2e/live-feed.spec.ts`.

### Task 1: Capture and document the Pump live contract

**Files:**
- Create: `docs/evidence/pump-realtime-contract.md`
- Create: `tests/fixtures/pump-realtime.redacted.json`
- Test: `tests/unit/pump-raw-schema.test.ts`

- [ ] **Step 1: Capture one Following snapshot, one follow/unfollow update, and paired buy/sell live messages**

Use Chrome DevTools on a logged-in Pump tab. Redact cookies, headers, signatures,
wallet secrets, unrelated identities, and raw URLs containing session data. Keep
only the minimum message envelopes needed to prove field paths.

- [ ] **Step 2: Write the evidence contract**

Document exact transport URL pattern, message discriminator, Following key,
trader key, transaction hash, action, chain, token, amount, market cap, and time.
Mark every absent field explicitly; do not infer undocumented values.

- [ ] **Step 3: Add a failing fixture-schema test**

```ts
it('accepts the redacted confirmed Pump live fixture', () => {
  const fixture = loadPumpFixture();
  expect(pumpRealtimeEnvelopeSchema.safeParse(fixture.trade).success).toBe(true);
  expect(pumpFollowingEnvelopeSchema.safeParse(fixture.following).success).toBe(true);
});
```

- [ ] **Step 4: Run the focused test**

Run: `pnpm vitest run tests/unit/pump-raw-schema.test.ts`
Expected: FAIL because `src/pump/raw-schema.ts` does not exist.

- [ ] **Step 5: Stop if the feasibility gate fails**

Do not continue to Task 2 unless all required fields in the design spec are
confirmed from the page-real-time path.

### Task 2: Add bounded Pump schemas and normalization

**Files:**
- Create: `src/pump/raw-schema.ts`
- Create: `src/pump/network-map.ts`
- Create: `src/pump/normalize.ts`
- Test: `tests/unit/pump-raw-schema.test.ts`
- Test: `tests/unit/pump-normalize.test.ts`

- [ ] **Step 1: Define strict bounded envelopes from the captured contract**

```ts
export const pumpSourceSchema = z.literal('pump');
export const pumpTransactionHashSchema = z.string().trim().min(1).max(128);
export const pumpTraderIdSchema = z.string().trim().min(1).max(128);
```

Build the remaining object paths from the redacted fixture; passthrough is
allowed only at the outer page-owned envelope, never on the canonical payload.

- [ ] **Step 2: Add normalization tests for every confirmed action and chain**

Assert canonical token address, trader identity, transaction hash, event time,
USD amount, optional market cap, and `sources: ['pump']`.

- [ ] **Step 3: Implement explicit Pump chain mapping and normalizer**

Unknown chain values must return `unknown`. Market cap remains undefined when
absent. No HTTP enrichment is permitted.

- [ ] **Step 4: Run focused tests**

Run: `pnpm vitest run tests/unit/pump-raw-schema.test.ts tests/unit/pump-normalize.test.ts`
Expected: PASS.

### Task 3: Evolve the canonical event and database safely

**Files:**
- Modify: `src/domain/activity.ts`
- Modify: `src/domain/event-validation.ts`
- Modify: `src/storage/database.ts`
- Modify: `src/storage/event-repository.ts`
- Test: `tests/unit/event-repository.test.ts`

- [ ] **Step 1: Add failing migration and validation tests**

Cover version-1 Fomo row migration, new Pump row validation, non-empty unique
sources, optional transaction hash bounds, and preservation of annotations.

- [ ] **Step 2: Introduce the version-2 canonical shape**

```ts
export type ActivitySource = 'fomo' | 'pump';

export interface TradeEventV2 extends Omit<TradeEventV1, 'schemaVersion' | 'source'> {
  schemaVersion: 2;
  sources: readonly ActivitySource[];
  transactionHash?: string;
  traderWallet?: string;
  sourceProfiles?: Partial<Record<ActivitySource, string>>;
}

export type TradeEvent = TradeEventV1 | TradeEventV2;
```

- [ ] **Step 3: Add the Dexie migration**

Upgrade every valid version-1 row to version 2 with `sources: ['fomo']`; preserve
IDs, read state, metrics, timestamps, and all financial fields.

- [ ] **Step 4: Run repository and validation tests**

Run: `pnpm vitest run tests/unit/event-repository.test.ts tests/unit/messaging.test.ts`
Expected: PASS.

### Task 4: Observe Pump transport and bridge exact-origin messages

**Files:**
- Create: `src/pump/realtime-observer.ts`
- Create: `src/pump/bridge.ts`
- Create: `entrypoints/pump-interceptor.content.ts`
- Create: `entrypoints/pump-bridge.content.ts`
- Modify: `src/messaging/protocol.ts`
- Modify: `src/messaging/guards.ts`
- Modify: `wxt.config.ts`
- Test: `tests/unit/pump-realtime-observer.test.ts`
- Test: `tests/integration/pump-bridge.test.ts`
- Test: `tests/unit/manifest-config.test.ts`

- [ ] **Step 1: Write observer tests against a fake WebSocket/fetch transport**

Assert transparent constructor semantics, original page delivery, bounded
message forwarding, reinstall idempotency, and clean uninstall behavior.

- [ ] **Step 2: Write hostile bridge tests**

Reject non-window sources, `blob:`/HTTP origins, wrong namespace/version,
oversized frames, malformed Following snapshots, and unsupported message kinds.

- [ ] **Step 3: Implement the observer and bridge**

Use a Pump-specific namespace and message discriminants. Never forward headers,
cookies, storage values, or arbitrary response bodies.

- [ ] **Step 4: Register Pump entrypoints and permissions**

Add only `https://pump.fun/*` to content-script matches and host permissions.

- [ ] **Step 5: Run boundary tests**

Run: `pnpm vitest run tests/unit/pump-realtime-observer.test.ts tests/integration/pump-bridge.test.ts tests/unit/manifest-config.test.ts`
Expected: PASS.

### Task 5: Maintain Following membership and independent connection state

**Files:**
- Create: `src/pump/following-set.ts`
- Modify: `src/background/connection-state.ts`
- Modify: `src/messaging/protocol.ts`
- Modify: `entrypoints/background.ts`
- Test: `tests/unit/pump-following-set.test.ts`
- Test: `tests/unit/connection-state.test.ts`

- [ ] **Step 1: Test snapshot replacement and incremental follow changes**

Verify exact identity membership, malformed update rejection, no fuzzy handle
matching, and a monotonically recorded `connectedAt` watermark.

- [ ] **Step 2: Implement the in-memory Following set**

The set is initialized only from a confirmed current-account snapshot. On page
reload it resets until a new snapshot arrives; it never loads Activity history.

- [ ] **Step 3: Model source-specific connection state**

```ts
export interface SourceConnectionState {
  pagePresent: boolean;
  authenticated: boolean;
  streamConnected: boolean;
  followingReady: boolean;
  connectedAt?: number;
  lastEventAt?: number;
}
```

- [ ] **Step 4: Run state tests**

Run: `pnpm vitest run tests/unit/pump-following-set.test.ts tests/unit/connection-state.test.ts`
Expected: PASS.

### Task 6: Merge counter-legs and cross-source duplicates

**Files:**
- Create: `src/domain/event-deduplication.ts`
- Modify: `src/storage/event-repository.ts`
- Modify: `src/background/ingest-activity.ts`
- Modify: `entrypoints/background.ts`
- Test: `tests/unit/event-deduplication.test.ts`
- Test: `tests/unit/ingest-activity.test.ts`

- [ ] **Step 1: Add failing deduplication tests**

Cover exact transaction merge, Pump stablecoin counter-leg suppression, source
event ID duplication, conservative fallback match, conflicting-amount retention,
and dual-source merge without changing the canonical event ID.

- [ ] **Step 2: Implement pure matching and merge functions**

```ts
export function mergeEventSources(existing: TradeEventV2, incoming: TradeEventV2): TradeEventV2 {
  return {
    ...existing,
    sources: [...new Set([...existing.sources, ...incoming.sources])],
    sourceProfiles: { ...existing.sourceProfiles, ...incoming.sourceProfiles },
  };
}
```

Keep the fallback time window and numeric tolerance named constants. Return no
match when any required fallback field is missing.

- [ ] **Step 3: Add merge-aware repository upsert**

Return `inserted`, `merged`, or `duplicate`. Broadcast and play audio only for
`inserted`; notify surfaces without audio for `merged`.

- [ ] **Step 4: Run ingestion tests**

Run: `pnpm vitest run tests/unit/event-deduplication.test.ts tests/unit/ingest-activity.test.ts tests/unit/buy-sound.test.ts`
Expected: PASS.

### Task 7: Add source filters and Pump navigation

**Files:**
- Create: `src/navigation/pump-links.ts`
- Modify: `src/popup/event-query.ts`
- Modify: `src/popup/use-event-feed.ts`
- Modify: `src/messaging/protocol.ts`
- Modify: `src/storage/event-repository.ts`
- Test: `tests/unit/event-query.test.ts`
- Test: `tests/unit/navigation.test.ts`

- [ ] **Step 1: Test All/Fomo/Pump semantics**

A dual-source event must match both single-source filters while rendering once.
Source filtering must compose with action, chain, market-cap range, trader, and
search filters.

- [ ] **Step 2: Add safe Pump URL builders**

Accept only validated Pump profile identifiers and chain-aware contract
addresses. Emit fixed-origin HTTPS URLs and reject all other input.

- [ ] **Step 3: Implement source query plumbing**

Use a source predicate on bounded result pages unless a safe Dexie multi-entry
index is justified by measurements; avoid a migration solely for three values.

- [ ] **Step 4: Run query and navigation tests**

Run: `pnpm vitest run tests/unit/event-query.test.ts tests/unit/navigation.test.ts`
Expected: PASS.

### Task 8: Build the compact three-row source-aware UI

**Files:**
- Create: `src/sidepanel/SourceBadge.tsx`
- Create: `src/sidepanel/SourceStatus.tsx`
- Modify: `src/popup/EventCard.tsx`
- Modify: `src/sidepanel/FeedFilterPopover.tsx`
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `entrypoints/sidepanel/sidepanel.css`
- Modify: `src/i18n/catalog.ts`
- Test: `tests/unit/EventCard.test.tsx`
- Test: `tests/unit/FeedFilterPopover.test.tsx`
- Test: `tests/unit/SidePanelApp.test.tsx`
- Test: `tests/unit/sidepanel-style-contract.test.ts`

- [ ] **Step 1: Add failing component and style-contract tests**

Assert single/dual source badges, tooltips, accessible names, profile links,
source filter pressed states, three-row DOM order, time on the identity row, CA
alignment, no token-row reorder, and card-height regression limits.

- [ ] **Step 2: Implement source badges and status controls**

Render the locally bundled official assets through `SourceIcon`: Fomo from
`https://fomo.family/favicon.svg` and Pump from
`https://pump.fun/icon.png`. Do not reuse the generic extension icon, the
temporary `P` placeholder, or remote runtime URLs.

- [ ] **Step 3: Preserve the card structure and reduce only gaps/padding**

Keep `.event-card-header`, `.event-action-line`, and `.event-footer` in that
order. Do not hide the handle, CA, note, amount, chain, token, or market cap.

- [ ] **Step 4: Add source controls to the compact filter surface**

All is selected by default. Pure icon controls require localized tooltip text,
`aria-label`, `aria-pressed`, keyboard focus rings, and at least a 32px hit area.
For a dual-source event, All renders both badges while Fomo/Pump selection
renders only the selected badge. Add the inclusive raw-USD buy-amount range
defined by the companion plan; it filters buys only and leaves every non-buy
action unaffected.

- [ ] **Step 5: Run component tests**

Run: `pnpm vitest run tests/unit/EventCard.test.tsx tests/unit/FeedFilterPopover.test.tsx tests/unit/SidePanelApp.test.tsx tests/unit/sidepanel-style-contract.test.ts`
Expected: PASS.

### Task 9: Integrate sound, surfaces, diagnostics, and E2E fixtures

**Files:**
- Modify: `src/background/buy-sound.ts`
- Modify: `src/background/pipeline-health.ts`
- Modify: `src/background/diagnostics.ts`
- Modify: `tests/e2e/fixture-server.ts`
- Create: `tests/e2e/fixtures/pump-page.html`
- Modify: `tests/e2e/live-feed.spec.ts`

- [ ] **Step 1: Add a deterministic Pump fixture page**

The fixture exposes a fake Following snapshot and controllable real-time
transport. It must not contact Pump or use production account data.

- [ ] **Step 2: Add E2E scenarios**

Test Pump-only, both sources, background Pump tab, new-event-only watermark,
follow/unfollow, stablecoin-leg merge, dual-source merge, one sound, source
filtering, disconnect states, side panel, floating window, and document PiP.

- [ ] **Step 3: Add redacted diagnostics**

Record source-specific counters and closed failure codes only. Assert that raw
frames, URLs, auth values, and trader payloads never appear in diagnostics.

- [ ] **Step 4: Run integration and E2E tests**

Run: `pnpm vitest run tests/integration/pump-bridge.test.ts tests/unit/buy-sound.test.ts tests/unit/diagnostics.test.ts`
Expected: PASS.

Run: `pnpm playwright test tests/e2e/live-feed.spec.ts`
Expected: PASS.

### Task 10: Full verification and local package

**Files:**
- Modify only files required by failures attributable to this feature.

- [ ] **Step 1: Review the working tree**

Run: `git status --short` and `git diff --check`.
Expected: no whitespace errors; unrelated pre-existing changes remain untouched.

- [ ] **Step 2: Run static and unit verification**

Run: `pnpm typecheck`
Expected: PASS.

Run: `pnpm test`
Expected: PASS.

- [ ] **Step 3: Build the extension**

Run: `pnpm build`
Expected: PASS with Pump content scripts included in the WXT manifest.

- [ ] **Step 4: Run the end-to-end suite**

Run: `pnpm test:e2e`
Expected: PASS.

- [ ] **Step 5: Produce a local install package**

Run: `pnpm package:local`
Expected: PASS and a newly generated local Chrome package under `.output/releases/`.

- [ ] **Step 6: Perform manual acceptance**

Load the unpacked build, keep logged-in Fomo and Pump tabs open in the
background, and verify source status, new-only Pump activity, source filtering,
three-row layout, dual badges, token/profile navigation, one buy sound, floating
window, and document PiP.

## Self-review

- Every product decision in the design spec maps to a task above.
- No task authorizes per-trader Activity polling or historical Pump import.
- The feasibility gate precedes production parser work.
- Multi-source identity, persistence, filtering, UI, audio, and navigation use
  the same `ActivitySource` vocabulary.
- Existing dirty working-tree files are not reset, overwritten, or included in
  future commits unless they belong to the active change.
