# Streamlined Feed, Verified Chain, and Local Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a controls-free activity feed with Settings-only locale selection, optional inline followers, verified Fomo chain/CA presentation, and reliable automatic on-device opinion translation.

**Architecture:** Treat Fomo `networkId` as the authoritative chain discriminator and require captured evidence before enabling a mapping. Migrate preferences to V3 without configurable metrics, reduce the Side Panel to a default newest-first query, and share one Chrome translation coordinator across all cards.

**Tech Stack:** TypeScript, React 19, WXT/Chrome MV3, Zod, Dexie, Chrome Translator/Language Detector, Vitest, Testing Library, Playwright/CDP.

---

## Rules

- Use TDD for each behavior change.
- Never enable guessed network IDs or follower JSON paths.
- Never send opinion text to a remote translation service.
- Preserve unrelated working-tree changes.
- Do not commit implementation without explicit user authorization.

### Task 1: Capture and promote chain evidence

**Files:**
- Modify: `docs/evidence/fomo-network-catalog.md`
- Modify: `docs/evidence/fomo-activity-contract.md`
- Modify: `tests/fixtures/fomo-activity-variants.ts`
- Modify: `src/fomo/network-map.ts`
- Test: `tests/unit/fomo-normalize.test.ts`
- Test: `tests/unit/diagnostics.test.ts`

- [ ] Capture one authenticated Fomo activity for BSC, Solana, Robinhood,
  Base, Ethereum, and X Layer; retain raw frames outside Git.
- [ ] Record visible chain label, numeric `networkId`, redacted address family,
  capture timestamp, and private-capture SHA-256.
- [ ] Write failing tests asserting each captured ID maps to its exact `ChainKey`
  while an unlisted ID stays `unknown`.
- [ ] Run `corepack pnpm vitest run tests/unit/fomo-normalize.test.ts tests/unit/diagnostics.test.ts`; expect mapping failures.
- [ ] Promote only captured entries to `verified-from-capture`.
- [ ] Rerun the focused tests; expect PASS.

### Task 2: Validate CA and reclassify stored events

**Files:**
- Modify: `src/navigation/contract-address.ts`
- Modify: `src/sidepanel/CopyableAddress.tsx`
- Modify: `src/storage/event-repository.ts`
- Modify: `entrypoints/background.ts`
- Test: `tests/unit/navigation.test.ts`
- Test: `tests/unit/CopyableAddress.test.tsx`
- Test: `tests/unit/event-repository.test.ts`
- Test: `tests/unit/popup-worker-boundary.test.ts`

- [ ] Write failing valid/invalid tests for every captured address family.
- [ ] Implement a closed validation result with `unknown-chain` and
  `invalid-address`; never infer an EVM chain from `0x`.
- [ ] Test that valid known-chain CA exposes copy while unknown/invalid CA is
  selectable non-interactive text.
- [ ] Test an IndexedDB `unknown` row with verified `networkId` is reclassified
  without changing read state, annotations, timestamps, thesis, or snapshots.
- [ ] Implement idempotent bootstrap reclassification; a second run updates zero rows.
- [ ] Run `corepack pnpm vitest run tests/unit/navigation.test.ts tests/unit/CopyableAddress.test.tsx tests/unit/event-repository.test.ts tests/unit/popup-worker-boundary.test.ts`; expect PASS.

### Task 3: Migrate preferences to V3 and remove metrics

**Files:**
- Modify: `src/domain/settings.ts`
- Modify: `src/storage/local-preferences.ts`
- Modify: `src/popup/SettingsPanel.tsx`
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `src/i18n/catalog.ts`
- Test: `tests/unit/local-preferences.test.ts`
- Test: `tests/unit/SettingsPanel.test.tsx`
- Test: `tests/unit/SidePanelApp.test.tsx`

- [ ] Write failing V1/V2-to-V3 migration tests; V3 has notifications,
  filters, `uiLocale`, and `opinionTranslation`, but no `metrics`.
- [ ] Assert retained values survive migration and concurrent updates remain serialized.
- [ ] Implement V3 as the only returned/written shape while retaining V1/V2 parsers for migration.
- [ ] Write UI tests proving Settings has locale/translation controls and no metric selectors.
- [ ] Remove metric handlers, selectors, unused catalog entries, and dead styles.
- [ ] Run `corepack pnpm vitest run tests/unit/local-preferences.test.ts tests/unit/SettingsPanel.test.tsx tests/unit/SidePanelApp.test.tsx`; expect PASS.

### Task 4: Reduce Side Panel to a pure feed

**Files:**
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `src/popup/HistoryFeed.tsx`
- Modify: `src/popup/use-event-feed.ts`
- Modify: `entrypoints/sidepanel/sidepanel.css`
- Delete: `src/sidepanel/FilterToolbar.tsx`
- Delete: `src/sidepanel/ActiveFilterChips.tsx`
- Test: `tests/unit/SidePanelApp.test.tsx`
- Test: `tests/unit/HistoryFeed.test.tsx`
- Modify: `tests/unit/sidepanel-composition-boundary.test.ts`

- [ ] Write failing tests proving the main view contains no search, Filters,
  Unread, Pinned, chips, Reset, or locale switcher.
- [ ] Assert Settings contains exactly one locale switcher.
- [ ] Assert default newest-first pagination and live/manual refresh retain
  existing stale-request protections.
- [ ] Remove control state, callbacks, components, tests, and styles; preserve
  refresh, connection, Settings, annotations, pagination, and live refresh.
- [ ] Run `corepack pnpm vitest run tests/unit/SidePanelApp.test.tsx tests/unit/HistoryFeed.test.tsx tests/unit/sidepanel-composition-boundary.test.ts`; expect PASS.

### Task 5: Move optional followers into identity

**Files:**
- Modify: `src/popup/EventCard.tsx`
- Modify: `src/overlay/ToastStack.tsx`
- Modify: `src/overlay/format.ts`
- Modify: `entrypoints/sidepanel/sidepanel.css`
- Modify: `entrypoints/trading-overlay.content/style.css`
- Test: `tests/unit/EventCard.test.tsx`
- Test: `tests/unit/ToastStack.test.tsx`
- Test: `tests/unit/format.test.ts`

- [ ] Write formatter tests accepting only finite non-negative integers and
  returning compact values or `undefined`.
- [ ] Write card tests for inline `12.35K followers`, complete omission when
  missing, and absence of `.event-metrics`/7-day placeholders.
- [ ] Render only `metricSnapshot.followers` beside trader identity and make
  the narrow layout wrap safely.
- [ ] Remove metric-slot iteration and metric grids from cards and Toasts.
- [ ] Run `corepack pnpm vitest run tests/unit/EventCard.test.tsx tests/unit/ToastStack.test.tsx tests/unit/format.test.ts`; expect PASS.

### Task 6: Repair automatic local translation

**Files:**
- Modify: `src/translation/browser-translation.ts`
- Modify: `src/translation/opinion-translation.ts`
- Modify: `src/translation/use-opinion-translation.ts`
- Modify: `src/sidepanel/TranslatedOpinion.tsx`
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Test: `tests/unit/browser-translation.test.ts`
- Test: `tests/unit/opinion-translation.test.ts`
- Test: `tests/unit/use-opinion-translation.test.ts`
- Test: `tests/unit/TranslatedOpinion.test.tsx`

- [ ] Reproduce detector/translator unavailable, downloadable,
  `NotAllowedError`, activated create, same-language skip, late unmount, and
  multiple-card same-pair scenarios with contract doubles.
- [ ] Run the four focused suites and verify the reproduced failure.
- [ ] Normalize availability, call `create()` for downloadable/downloading,
  classify activation errors, and keep original text visible.
- [ ] Enforce one panel coordinator, same-pair single-flight, LRU session cap,
  latest-wins requests, and late-session destruction.
- [ ] Ensure enabled opinions translate automatically; activation UI appears
  only when Chrome requires it; locale switching never changes translation preferences.
- [ ] Rerun the focused suites; expect PASS.

### Task 7: Add real-extension E2E coverage

**Files:**
- Modify: `tests/e2e/fixture-server.ts`
- Modify: `tests/e2e/fixtures/fomo-page.html`
- Modify: `tests/e2e/live-feed.spec.ts`
- Modify: `docs/manual-testing.zh-CN.md`

- [ ] Add synthetic fixtures using the six captured IDs, valid addresses, one
  follower-bearing trader, and one trader without followers.
- [ ] At 280 px assert no removed controls or horizontal overflow.
- [ ] Switch locale only through Settings and assert translation preferences remain unchanged.
- [ ] Assert exact badge and CA for each chain; use a real CDP click and verify
  `clipboard.writeText` plus no navigation; unknown remains non-copyable.
- [ ] Install a contract-accurate translation double before app startup and
  verify automatic translation plus downloadable activation.
- [ ] Update the manual clean-profile test for Chrome 138+, model download,
  observed `networkId`, and absence of remote opinion-text requests.
- [ ] Run `CI=true corepack pnpm test:e2e`; expect PASS outside the sandbox.

### Task 8: Final regression and release audit

**Files:**
- Modify only files revealed by the audit

- [ ] Run `rg -n "FilterToolbar|ActiveFilterChips|settings\.metrics|MetricKey|event-metrics|toast-metrics" src entrypoints tests`; expect only intentional migration compatibility references.
- [ ] Run `rg -n "infer.*chain|Google Translate|translate\.google|fetch\(.*translat" src entrypoints`; expect no CA-only EVM inference or remote translation.
- [ ] Run `CI=true corepack pnpm check`; expect typecheck, all Vitest suites, and WXT build PASS.
- [ ] Run `CI=true corepack pnpm test:e2e`; expect PASS.
- [ ] Manually verify six real-chain activities, exact CA copy, automatic clean-profile translation, Settings-only locale, missing-followers omission, reconnect refresh, and 280 px layout.
- [ ] Run `git diff --check` and `git status --short`; inspect every remaining change before requesting commit authorization.
