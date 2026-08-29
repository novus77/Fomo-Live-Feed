# Feed Filters, Robinhood Label, and Profile Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compact header filter popover for action visibility and K-denominated market-cap ranges, abbreviate Robinhood as `rh`, and route trader links to Fomo's `/profile/` pages.

**Architecture:** Extend the existing popup-side post-filter model so no repository indexes, persistence schemas, or network APIs change. Add one focused Side Panel popover component with local draft validation, then compose it into the existing mutually exclusive header-panel state. Keep chain presentation and safe Fomo URL construction centralized in their existing catalogs/builders.

**Tech Stack:** React, TypeScript, CSS, Vitest, Testing Library, Playwright, WXT

**Repository constraint:** Preserve all existing dirty-worktree changes. Do not create commits unless the user explicitly authorizes them.

---

## File Map

- Modify `src/popup/event-query.ts`: extend the applied filter model and popup-side predicates.
- Modify `tests/unit/event-query.test.ts`: cover action visibility, market-cap bounds, counting, and bounded scanning.
- Create `src/sidepanel/market-cap-range.ts`: parse K-denominated draft inputs without mixing UI state into feed predicates.
- Create `tests/unit/market-cap-range.test.ts`: cover empty, one-sided, decimal, invalid, and reversed drafts.
- Create `src/sidepanel/FeedFilterPopover.tsx`: focused funnel trigger and two-row popover.
- Create `tests/unit/FeedFilterPopover.test.tsx`: cover toggles, validation, reset, focus, and outside-click behavior.
- Modify `src/sidepanel/SidePanelApp.tsx`: mount the filter before refresh/settings/support and share mutually exclusive panel state.
- Modify `tests/unit/SidePanelApp.test.tsx`: cover control order, icon-only support, and integration with feed filters.
- Modify `entrypoints/sidepanel/sidepanel.css`: style compact header controls and responsive filter popover in both themes.
- Modify `src/i18n/catalog.ts`: add English/Chinese filter labels and range error strings.
- Modify `tests/unit/i18n-catalog.test.ts`: validate new catalog entries and interpolation safety.
- Modify `src/sidepanel/chain-presentation.tsx`: change Robinhood display label to `rh`.
- Modify `tests/unit/ChainBadge.test.tsx`: lock down the new abbreviation and presentation invariants.
- Modify `src/navigation/fomo-links.ts`: change profile path to `/profile/`.
- Modify `tests/unit/navigation.test.ts` and `tests/unit/HistoryFeed.test.tsx`: cover the safe new profile URL.
- Modify `tests/e2e/live-feed.spec.ts`: cover the header, filters, Robinhood label, profile URL, and 280px layout.

### Task 1: Extend the Applied Feed Filter Model

**Files:**
- Modify: `src/popup/event-query.ts`
- Test: `tests/unit/event-query.test.ts`

- [ ] **Step 1: Write failing predicate and count tests**

Add tests for the default model, each controlled action, always-visible withdraw/transfer, inclusive bounds, one-sided bounds, missing market cap, and active group counting:

```ts
expect(matchesPostFilters(makeEvent({ action: 'buy' }), DEFAULT_FILTERS, EMPTY_ANNOTATIONS)).toBe(true);

const withoutBuy = {
  ...DEFAULT_FILTERS,
  visibleActions: { buy: false, sell: true, thesis: true },
};
expect(matchesPostFilters(makeEvent({ action: 'buy' }), withoutBuy, EMPTY_ANNOTATIONS)).toBe(false);
expect(matchesPostFilters(makeEvent({ action: 'transfer' }), withoutBuy, EMPTY_ANNOTATIONS)).toBe(true);

const range = { ...DEFAULT_FILTERS, minimumMarketCap: 200_000, maximumMarketCap: 500_000 };
expect(matchesPostFilters(makeEvent({ marketCap: 200_000 }), range, EMPTY_ANNOTATIONS)).toBe(true);
expect(matchesPostFilters(makeEvent({ marketCap: 500_000 }), range, EMPTY_ANNOTATIONS)).toBe(true);
expect(matchesPostFilters(makeEvent({ marketCap: 199_999 }), range, EMPTY_ANNOTATIONS)).toBe(false);
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
corepack pnpm vitest run tests/unit/event-query.test.ts
```

Expected: FAIL because the new filter fields and predicates do not exist.

- [ ] **Step 3: Add exact filter types and defaults**

Add:

```ts
export type FilterableAction = Extract<ActivityAction, 'buy' | 'sell' | 'thesis'>;

export interface VisibleActionFilters {
  buy: boolean;
  sell: boolean;
  thesis: boolean;
}

export const DEFAULT_VISIBLE_ACTIONS: VisibleActionFilters = {
  buy: true,
  sell: true,
  thesis: true,
};
```

Extend `PopupEventFilters` with `visibleActions`, `minimumMarketCap`, and `maximumMarketCap`. Initialize them in `DEFAULT_FILTERS`. Retain the legacy singular `action` field for the popup-only toolbar.

- [ ] **Step 4: Implement pure matching and group counting**

In `matchesPostFilters`, keep the existing legacy singular action check, then apply:

```ts
if (
  (event.action === 'buy' || event.action === 'sell' || event.action === 'thesis')
  && !filters.visibleActions[event.action]
) {
  return false;
}

if (filters.minimumMarketCap !== undefined || filters.maximumMarketCap !== undefined) {
  if (typeof event.marketCap !== 'number' || !Number.isFinite(event.marketCap)) return false;
  if (filters.minimumMarketCap !== undefined && event.marketCap < filters.minimumMarketCap) return false;
  if (filters.maximumMarketCap !== undefined && event.marketCap > filters.maximumMarketCap) return false;
}
```

Add a focused `activeSidePanelFilterGroupCount` returning 0–2. Update comments so action visibility and market cap are documented as popup-side post-filters.

- [ ] **Step 5: Prove bounded page continuation**

Add a `loadEventPages` test whose first full page is removed by the market-cap/action predicates and whose next page contains a match. Assert both pages are requested and cursor progression terminates correctly.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
corepack pnpm vitest run tests/unit/event-query.test.ts tests/unit/HistoryFeed.test.tsx
corepack pnpm typecheck
```

Expected: all tests pass and TypeScript exits 0.

### Task 2: Parse K-Denominated Market-Cap Drafts

**Files:**
- Create: `src/sidepanel/market-cap-range.ts`
- Create: `tests/unit/market-cap-range.test.ts`

- [ ] **Step 1: Write failing parser tests**

Cover:

```ts
expect(parseMarketCapRange('', '')).toEqual({ ok: true, minimum: undefined, maximum: undefined });
expect(parseMarketCapRange('200', '500')).toEqual({ ok: true, minimum: 200_000, maximum: 500_000 });
expect(parseMarketCapRange('12.5', '')).toEqual({ ok: true, minimum: 12_500, maximum: undefined });
expect(parseMarketCapRange('', '500')).toEqual({ ok: true, minimum: undefined, maximum: 500_000 });
expect(parseMarketCapRange('-1', '')).toEqual({ ok: false, reason: 'invalid-number' });
expect(parseMarketCapRange('500', '200')).toEqual({ ok: false, reason: 'reversed-range' });
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
corepack pnpm vitest run tests/unit/market-cap-range.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement a strict finite parser**

Export a discriminated union and `parseMarketCapRange(minimumDraft, maximumDraft)`. Trim inputs, treat empty as absent, reject non-finite/negative values, multiply valid K values by 1,000, reject overflow to non-finite USD, and return `reversed-range` when both normalized values exist and minimum exceeds maximum.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
corepack pnpm vitest run tests/unit/market-cap-range.test.ts
corepack pnpm typecheck
```

Expected: parser tests pass and TypeScript exits 0.

### Task 3: Build the Focused Header Filter Popover

**Files:**
- Create: `src/sidepanel/FeedFilterPopover.tsx`
- Create: `tests/unit/FeedFilterPopover.test.tsx`
- Modify: `src/i18n/catalog.ts`
- Modify: `tests/unit/i18n-catalog.test.ts`

- [ ] **Step 1: Add catalog entries and failing UI tests**

Add English/Chinese keys for filter trigger/dialog, action row, market-cap range, minimum/maximum labels, reversed/invalid input, and reset. In component tests assert the trigger is icon-only, uses `aria-haspopup="dialog"`, toggles `aria-expanded`, and renders three `aria-pressed` buttons plus two numeric inputs.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
corepack pnpm vitest run tests/unit/FeedFilterPopover.test.tsx tests/unit/i18n-catalog.test.ts
```

Expected: FAIL because the component and catalog entries do not exist.

- [ ] **Step 3: Implement the controlled popover shell**

Define props:

```ts
interface FeedFilterPopoverProps {
  filters: PopupEventFilters;
  open: boolean;
  onOpenChange(open: boolean): void;
  onFiltersChange(filters: PopupEventFilters): void;
}
```

Render an icon-only funnel trigger with localized `aria-label`/`title`, active group badge, `aria-expanded`, and `aria-haspopup="dialog"`. Render the popover only when open. Use refs plus document click/Escape listeners following the existing `FilterToolbar` pattern; Escape returns focus to the trigger.

- [ ] **Step 4: Implement independent action toggles**

Each action button copies `filters.visibleActions` and flips only its own key. Use localized action labels from `ACTION_LABEL_KEYS`, a visible check mark, and `aria-pressed`. Do not expose withdraw/transfer controls.

- [ ] **Step 5: Implement valid-draft application**

Initialize draft strings from applied USD bounds divided by 1,000. On every draft change, call `parseMarketCapRange`. For `ok: true`, clear the error and call `onFiltersChange` with normalized applied values. For either error, keep the current applied filter props unchanged and show the localized inline error. Reset restores `DEFAULT_VISIBLE_ACTIONS`, clears both drafts and errors, and removes both applied bounds.

- [ ] **Step 6: Add interaction regressions**

Test all-off actions, transfer/withdraw absence from UI, decimal K normalization, one-sided ranges, reversed-range retention, correction after error, reset, outside-click close, Escape close/focus return, trigger count badge 0–2, and no visible button text beside the funnel icon.

- [ ] **Step 7: Verify GREEN**

Run:

```bash
corepack pnpm vitest run tests/unit/FeedFilterPopover.test.tsx tests/unit/i18n-catalog.test.ts
corepack pnpm typecheck
```

Expected: all tests pass and TypeScript exits 0.

### Task 4: Compose the Header Controls and Styles

**Files:**
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `tests/unit/SidePanelApp.test.tsx`
- Modify: `entrypoints/sidepanel/sidepanel.css`

- [ ] **Step 1: Write failing header composition tests**

Assert the header controls occur in DOM order filter → refresh → settings → support. Assert support contains only its SVG, keeps its localized accessible name/title, and no longer renders visible support text. Assert opening filters closes settings/support and vice versa.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
corepack pnpm vitest run tests/unit/SidePanelApp.test.tsx
```

Expected: FAIL because the filter trigger is not mounted and support still has visible text.

- [ ] **Step 3: Integrate mutually exclusive header panels**

Extend `OpenUtilityPanel` to `'filters' | 'settings' | 'support' | null`. Mount `FeedFilterPopover` before `RefreshButton`, passing `filters`, `setFilters`, controlled open state, and `toggleUtilityPanel`. Remove the support text span while preserving the heart SVG and attributes.

- [ ] **Step 4: Create one compact header-button system**

Factor shared CSS selectors for the filter trigger, refresh, settings, and support controls: 32px square, centered icon, consistent radius/focus ring, and 6px group gap. Keep support's purple visual distinction. Add a relative anchor and absolute popover positioned below/right of the controls with a width bounded by `min(300px, calc(100vw - 24px))`.

- [ ] **Step 5: Style the two-row popover and themes**

Add selected action states matching buy/sell/thesis colors, compact K input shells with suffixes, error/reset styles, and light-theme overrides. Inputs must use `min-width: 0`; the three-column range row must fit at 280px without horizontal overflow.

- [ ] **Step 6: Verify GREEN**

Run:

```bash
corepack pnpm vitest run tests/unit/SidePanelApp.test.tsx tests/unit/FeedFilterPopover.test.tsx
corepack pnpm typecheck
corepack pnpm build
git diff --check
```

Expected: tests, typecheck, build, and diff check pass.

### Task 5: Abbreviate Robinhood and Correct Profile Navigation

**Files:**
- Modify: `src/sidepanel/chain-presentation.tsx`
- Modify: `tests/unit/ChainBadge.test.tsx`
- Modify: `src/navigation/fomo-links.ts`
- Modify: `tests/unit/navigation.test.ts`
- Modify: `tests/unit/HistoryFeed.test.tsx`

- [ ] **Step 1: Write failing label and URL tests**

Change expected Robinhood label to lowercase `rh`. Change valid profile pathname/href expectations from `/user/alpha` to `/profile/alpha`. Keep invalid-handle cases expecting null/non-link identity.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
corepack pnpm vitest run tests/unit/ChainBadge.test.tsx tests/unit/navigation.test.ts tests/unit/HistoryFeed.test.tsx
```

Expected: FAIL on current `Robinhood` and `/user/` values.

- [ ] **Step 3: Make the two centralized production changes**

Set:

```ts
robinhood: {
  label: 'rh',
  // existing token, color, and icon remain unchanged
}
```

Change only `PROFILE_PATH` to `'/profile/'` and update the stale provisional-path comment. Preserve the fixed origin, validation, encoding, and null behavior.

- [ ] **Step 4: Verify GREEN**

Run:

```bash
corepack pnpm vitest run tests/unit/ChainBadge.test.tsx tests/unit/navigation.test.ts tests/unit/HistoryFeed.test.tsx
corepack pnpm typecheck
```

Expected: all tests pass and TypeScript exits 0.

### Task 6: Add End-to-End Filter and Narrow-Header Coverage

**Files:**
- Modify: `tests/e2e/live-feed.spec.ts`

- [ ] **Step 1: Extend fixtures with filter-distinct events**

Ensure the main live-feed test contains buy/sell/thesis/transfer events with market caps below, inside, above, and missing from the chosen K range. Keep unique stable event IDs for direct DOM queries.

- [ ] **Step 2: Add header and popover assertions**

At normal width, assert header DOM order filter/refresh/settings/support, all four are icon-only or support icon-only as designed, the filter uses an accessible funnel trigger, and its count badge follows 0–2 group counting.

- [ ] **Step 3: Exercise action and range behavior**

Open the popover, disable buy/sell/thesis independently, confirm transfer remains, and re-enable actions. Enter minimum-only, maximum-only, and two-sided K ranges; verify inclusive card visibility and missing-market-cap exclusion. Enter a reversed range, assert the inline error, and verify the last valid visible set is unchanged.

- [ ] **Step 4: Assert Robinhood and profile navigation**

Assert the Robinhood test card displays `rh` and the trader identity href equals `https://fomo.family/profile/<fixture-handle>`.

- [ ] **Step 5: Extend the 280px geometry check**

Require all four header controls to have non-zero dimensions, remain within the header/card viewport, and avoid overlap. Open the popover at 280px and assert it and both K inputs fit without document horizontal overflow.

- [ ] **Step 6: Run complete verification**

Run:

```bash
git diff --check
corepack pnpm typecheck
corepack pnpm vitest run tests/unit/event-query.test.ts tests/unit/market-cap-range.test.ts tests/unit/FeedFilterPopover.test.tsx tests/unit/SidePanelApp.test.tsx tests/unit/ChainBadge.test.tsx tests/unit/navigation.test.ts tests/unit/HistoryFeed.test.tsx
corepack pnpm build
corepack pnpm test:e2e
```

Expected: all focused tests, typecheck, build, and all E2E tests pass. If an established unrelated diagnostics/reconnect E2E times out once, rerun that exact test and report both outcomes.

### Task 7: Reload the Verified Local Extension

**Files:**
- Build source: `.output/chrome-mv3`
- Installed target: `/Users/a77/Downloads/Fomo-Live-Feed-v0.1.0-chrome`

- [ ] **Step 1: Back up the installed unpacked extension**

Create a timestamped archive under `/private/tmp` before copying the build.

- [ ] **Step 2: Copy and hash-check the build**

Copy `.output/chrome-mv3/.` into the installed target and compare manifest, active sidepanel JS, and active sidepanel CSS hashes.

- [ ] **Step 3: Reload and inspect through Chrome**

Reload extension ID `oobclbdbkmlckpfbcfhoakhogflaedbg`, refresh an existing Fomo tab, open the Side Panel, and verify the four-control header, funnel popover, `rh` badge, market-cap range, and `/profile/` trader link when suitable live events exist.

- [ ] **Step 4: Report without overclaiming**

Report modified files, tests/build/E2E results, backup path, and exactly which live visual checks were possible. Do not claim a live-event behavior was observed when matching data was unavailable.
