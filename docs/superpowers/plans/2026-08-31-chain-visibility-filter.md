# Chain Visibility Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent six-chain multi-select filter to the Side Panel, always hide unknown-chain events, and preserve hidden events and buy-sound behavior.

**Architecture:** Introduce a small pure chain-visibility module that owns the supported closed set and conversions between visible chains and the existing `mutedChains` setting. Extend the popup-side post-filter and bounded pagination loop with a visible-chain array, then wire the Side Panel to persist changes through the already serialized `LocalPreferences.updateSettings` queue. Keep the filter UI presentational and give the feed an explicit no-chains-selected state.

**Tech Stack:** TypeScript, React 19, WXT MV3, Zod, Dexie/IndexedDB, Vitest, Testing Library, Playwright.

---

## File Structure

- Create `src/sidepanel/chain-visibility.ts`: closed six-chain set, normalization, visible/muted conversion, toggle and bulk helpers.
- Create `tests/unit/chain-visibility.test.ts`: pure state and normalization contract.
- Modify `src/popup/event-query.ts`: add visible-chain state, post-filter unknown/disabled chains, group count, and all-off pagination short-circuit.
- Modify `tests/unit/event-query.test.ts`: query, pagination, action-type, unknown, and group-count coverage.
- Create `src/sidepanel/ChainVisibilityFilter.tsx`: accessible two-column checklist and bulk action.
- Create `tests/unit/ChainVisibilityFilter.test.tsx`: component interaction contract.
- Modify `src/sidepanel/FeedFilterPopover.tsx`: compose chain group between actions and market cap and reset all groups.
- Modify `tests/unit/FeedFilterPopover.test.tsx`: popover integration and reset tests.
- Modify `src/sidepanel/SidePanelApp.tsx`: initialize from settings, persist muted chains, preserve optimistic session selection, and pass explicit empty-state controls.
- Modify `src/popup/HistoryFeed.tsx`: render the dedicated no-chains-selected state.
- Modify `tests/unit/HistoryFeed.test.tsx`: empty-state precedence and recovery action.
- Modify `src/i18n/catalog.ts`: English and Simplified Chinese strings.
- Modify `tests/unit/i18n-catalog.test.ts`: localization parity/expected labels.
- Modify `entrypoints/sidepanel/sidepanel.css`: approved two-column visual treatment and light-theme states.
- Modify `tests/unit/SidePanelApp.test.tsx`: settings restoration, persistence, failure behavior, and sound independence boundary.
- Modify `tests/e2e/live-feed.spec.ts`: real extension filtering, persistence, all-off recovery, and hidden-chain sound scenario.

### Task 1: Pure Chain Visibility Model

**Files:**
- Create: `src/sidepanel/chain-visibility.ts`
- Create: `tests/unit/chain-visibility.test.ts`

- [ ] **Step 1: Write failing tests for the closed set and normalization**

```ts
import { describe, expect, it } from 'vitest';

import {
  FILTERABLE_CHAINS,
  normalizeMutedChains,
  toMutedChains,
  toVisibleChains,
  toggleVisibleChain,
} from '../../src/sidepanel/chain-visibility';

describe('chain visibility', () => {
  it('exposes exactly the six approved chains in UI order', () => {
    expect(FILTERABLE_CHAINS).toEqual([
      'bsc', 'solana', 'base', 'robinhood', 'ethereum', 'x-layer',
    ]);
  });

  it('drops unknown, duplicates, and unsupported stored values', () => {
    expect(normalizeMutedChains(['unknown', 'bsc', 'bsc', 'monad'])).toEqual(['bsc']);
  });

  it('round-trips visible and muted sets in canonical order', () => {
    expect(toVisibleChains(['base', 'bsc'])).toEqual([
      'solana', 'robinhood', 'ethereum', 'x-layer',
    ]);
    expect(toMutedChains(['solana', 'ethereum'])).toEqual([
      'bsc', 'base', 'robinhood', 'x-layer',
    ]);
  });

  it('toggles without mutating the input and preserves canonical order', () => {
    const visible = [...FILTERABLE_CHAINS];
    expect(toggleVisibleChain(visible, 'base')).toEqual([
      'bsc', 'solana', 'robinhood', 'ethereum', 'x-layer',
    ]);
    expect(visible).toEqual(FILTERABLE_CHAINS);
  });
});
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: `corepack pnpm vitest run tests/unit/chain-visibility.test.ts`

Expected: FAIL because `src/sidepanel/chain-visibility.ts` does not exist.

- [ ] **Step 3: Implement the pure helper module**

```ts
import type { ChainKey } from '../domain/activity';

export type FilterableChain = Exclude<ChainKey, 'unknown'>;

export const FILTERABLE_CHAINS = [
  'bsc', 'solana', 'base', 'robinhood', 'ethereum', 'x-layer',
] as const satisfies readonly FilterableChain[];

const FILTERABLE_CHAIN_SET = new Set<ChainKey>(FILTERABLE_CHAINS);

export function normalizeMutedChains(values: readonly unknown[]): FilterableChain[] {
  const input = new Set(values.filter(
    (value): value is FilterableChain =>
      typeof value === 'string' && FILTERABLE_CHAIN_SET.has(value as ChainKey),
  ));
  return FILTERABLE_CHAINS.filter((chain) => input.has(chain));
}

export function toVisibleChains(muted: readonly unknown[]): FilterableChain[] {
  const normalized = new Set(normalizeMutedChains(muted));
  return FILTERABLE_CHAINS.filter((chain) => !normalized.has(chain));
}

export function toMutedChains(visible: readonly FilterableChain[]): FilterableChain[] {
  const selected = new Set(visible);
  return FILTERABLE_CHAINS.filter((chain) => !selected.has(chain));
}

export function toggleVisibleChain(
  visible: readonly FilterableChain[],
  chain: FilterableChain,
): FilterableChain[] {
  const selected = new Set(visible);
  selected.has(chain) ? selected.delete(chain) : selected.add(chain);
  return FILTERABLE_CHAINS.filter((candidate) => selected.has(candidate));
}
```

- [ ] **Step 4: Run the focused test and type checker**

Run: `corepack pnpm vitest run tests/unit/chain-visibility.test.ts && corepack pnpm exec tsc --noEmit`

Expected: 1 test file passes and TypeScript exits 0.

- [ ] **Step 5: Commit the pure model**

```bash
git add src/sidepanel/chain-visibility.ts tests/unit/chain-visibility.test.ts
git commit -m "feat: add chain visibility model"
```

### Task 2: Feed Filtering and Pagination Contract

**Files:**
- Modify: `src/popup/event-query.ts`
- Modify: `tests/unit/event-query.test.ts`

- [ ] **Step 1: Add failing tests for filtering all actions and unknown chains**

Add tests that construct `DEFAULT_FILTERS` with `visibleChains: ['bsc']` and assert:

```ts
expect(matchesPostFilters(makeEvent({ chain: 'bsc', action: 'transfer' }), filters, EMPTY_ANNOTATIONS)).toBe(true);
expect(matchesPostFilters(makeEvent({ chain: 'solana', action: 'withdraw' }), filters, EMPTY_ANNOTATIONS)).toBe(false);
expect(matchesPostFilters(makeEvent({ chain: 'unknown' }), DEFAULT_FILTERS, EMPTY_ANNOTATIONS)).toBe(false);
```

Add group-count expectations:

```ts
expect(activeSidePanelFilterGroupCount(DEFAULT_FILTERS)).toBe(0);
expect(activeSidePanelFilterGroupCount({
  ...DEFAULT_FILTERS,
  visibleChains: DEFAULT_FILTERS.visibleChains.filter((chain) => chain !== 'base'),
})).toBe(1);
expect(activeSidePanelFilterGroupCount({ ...DEFAULT_FILTERS, visibleChains: [] })).toBe(1);
```

- [ ] **Step 2: Add a failing all-off pagination test**

```ts
it('does not fetch history when no chains are visible', async () => {
  const fetchPage = vi.fn();
  const result = await loadEventPages(
    fetchPage,
    { ...DEFAULT_FILTERS, visibleChains: [] },
    EMPTY_ANNOTATIONS,
    50,
  );
  expect(fetchPage).not.toHaveBeenCalled();
  expect(result).toEqual({ events: [], cursor: null, hasMore: false, scanExceeded: false });
});
```

- [ ] **Step 3: Run focused tests and verify failures**

Run: `corepack pnpm vitest run tests/unit/event-query.test.ts`

Expected: FAIL because `PopupEventFilters.visibleChains` and its behavior do not exist.

- [ ] **Step 4: Extend the filter model and post-filter**

In `PopupEventFilters`, add:

```ts
visibleChains: readonly FilterableChain[];
```

Set the default to a copied complete list:

```ts
visibleChains: [...FILTERABLE_CHAINS],
```

At the start of `matchesPostFilters`, reject unknown and disabled chains:

```ts
if (
  event.chain === 'unknown'
  || !filters.visibleChains.includes(event.chain)
) {
  return false;
}
```

Count the group only when the set differs from all six supported chains:

```ts
const chainsChanged = filters.visibleChains.length !== FILTERABLE_CHAINS.length
  || FILTERABLE_CHAINS.some((chain) => !filters.visibleChains.includes(chain));
return Number(actionsChanged) + Number(chainsChanged) + Number(hasMarketCapRange);
```

Short-circuit `loadEventPages` before entering the fetch loop:

```ts
if (filters.visibleChains.length === 0) {
  return { events: [], cursor: fromCursor, hasMore: false, scanExceeded: false };
}
```

Keep the existing singular `chain` field and storage query mapping for the legacy full popup toolbar; visible chains remain a post-filter and are not sent over the worker protocol.

- [ ] **Step 5: Add a sparse-page regression test**

Use three pages where the first contains only Solana, the second contains BSC, and the filter selects only BSC. Assert `loadEventPages` fetches the second page and returns the BSC row after `matchesPostFilters` is applied.

- [ ] **Step 6: Run event-query and history-feed regression tests**

Run: `corepack pnpm vitest run tests/unit/event-query.test.ts tests/unit/HistoryFeed.test.tsx`

Expected: both test files pass.

- [ ] **Step 7: Commit the filtering contract**

```bash
git add src/popup/event-query.ts tests/unit/event-query.test.ts
git commit -m "feat: filter feed by visible chains"
```

### Task 3: Two-Column Chain Selector UI

**Files:**
- Create: `src/sidepanel/ChainVisibilityFilter.tsx`
- Create: `tests/unit/ChainVisibilityFilter.test.tsx`
- Modify: `src/sidepanel/FeedFilterPopover.tsx`
- Modify: `tests/unit/FeedFilterPopover.test.tsx`
- Modify: `src/i18n/catalog.ts`
- Modify: `tests/unit/i18n-catalog.test.ts`
- Modify: `entrypoints/sidepanel/sidepanel.css`

- [ ] **Step 1: Add localization keys in both catalogs**

Add identical keys to `EN_MESSAGES` and `ZH_MESSAGES`:

```ts
'feed.filterChains': 'Chains',
'feed.selectAll': 'Select all',
'feed.deselectAll': 'Deselect all',
'feed.noChainsSelected': 'No chains selected.',
'feed.selectAllChains': 'Select all chains',
```

Chinese values:

```ts
'feed.filterChains': '链',
'feed.selectAll': '全选',
'feed.deselectAll': '取消全选',
'feed.noChainsSelected': '当前未选择任何链。',
'feed.selectAllChains': '选择全部链',
```

Extend the catalog test to assert both locales resolve all five keys.

- [ ] **Step 2: Write failing component tests for the approved layout and behavior**

Render `ChainVisibilityFilter` with all chains visible and assert:

```ts
expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(6);
expect(screen.getByRole('button', { name: 'Deselect all' })).toBeInTheDocument();
expect(screen.getByRole('button', { name: 'RH', pressed: true })).toBeInTheDocument();
```

Click Base and assert the callback receives the five-chain canonical list. Click `Deselect all` and assert `[]`. Rerender with `[]`, click `Select all`, and assert `FILTERABLE_CHAINS`.

- [ ] **Step 3: Run the component test and verify the missing-component failure**

Run: `corepack pnpm vitest run tests/unit/ChainVisibilityFilter.test.tsx`

Expected: FAIL because `ChainVisibilityFilter.tsx` does not exist.

- [ ] **Step 4: Implement the presentational component**

Expose only this interface:

```ts
interface ChainVisibilityFilterProps {
  visibleChains: readonly FilterableChain[];
  onChange(visibleChains: FilterableChain[]): void;
}
```

Render a heading row with the dynamic bulk button and a two-column `role="group"`. Map `FILTERABLE_CHAINS` to buttons using `CHAIN_LABELS`, override only Robinhood's visible text to the shared approved `RH` presentation, set `aria-pressed`, and call `toggleVisibleChain`.

- [ ] **Step 5: Compose the component into the popover and reset path**

Insert it after the action section:

```tsx
<ChainVisibilityFilter
  visibleChains={filters.visibleChains}
  onChange={(visibleChains) => onFiltersChange({ ...filters, visibleChains })}
/>
```

Reset with a fresh array so later toggles cannot mutate shared defaults:

```ts
onFiltersChange({
  ...DEFAULT_FILTERS,
  visibleActions: { ...DEFAULT_VISIBLE_ACTIONS },
  visibleChains: [...FILTERABLE_CHAINS],
});
```

- [ ] **Step 6: Add the approved CSS**

Add `.feed-filter-heading`, `.feed-filter-bulk`, `.feed-filter-chains`, and `.feed-filter-chain` rules. Use `grid-template-columns: repeat(2, minmax(0, 1fr))`, the existing 8px control radius, existing purple selected tokens, and explicit light-theme selectors. Preserve a minimum 44px hit target and visible `:focus-visible` outline.

- [ ] **Step 7: Run focused UI and localization tests**

Run: `corepack pnpm vitest run tests/unit/ChainVisibilityFilter.test.tsx tests/unit/FeedFilterPopover.test.tsx tests/unit/i18n-catalog.test.ts`

Expected: all three files pass.

- [ ] **Step 8: Commit the selector UI**

```bash
git add src/sidepanel/ChainVisibilityFilter.tsx tests/unit/ChainVisibilityFilter.test.tsx src/sidepanel/FeedFilterPopover.tsx tests/unit/FeedFilterPopover.test.tsx src/i18n/catalog.ts tests/unit/i18n-catalog.test.ts entrypoints/sidepanel/sidepanel.css
git commit -m "feat: add chain selector to feed filters"
```

### Task 4: Persistence and Dedicated Empty State

**Files:**
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `src/popup/HistoryFeed.tsx`
- Modify: `tests/unit/SidePanelApp.test.tsx`
- Modify: `tests/unit/HistoryFeed.test.tsx`

- [ ] **Step 1: Write failing HistoryFeed empty-state tests**

Extend the test harness with `noChainsSelected` and `onSelectAllChains`. Assert that when `status === 'ready'`, `events` is empty, and `noChainsSelected` is true, the feed renders `No chains selected.` and a `Select all chains` button. Clicking invokes the callback once. Also assert loading and error states retain precedence.

- [ ] **Step 2: Implement the explicit HistoryFeed state**

Add props:

```ts
noChainsSelected: boolean;
onSelectAllChains(): void;
```

After loading/error handling and before the generic empty state, render:

```tsx
if (noChainsSelected) {
  return (
    <div className="feed-empty feed-empty-chains">
      <p>{translate('feed.noChainsSelected')}</p>
      <button type="button" onClick={onSelectAllChains}>
        {translate('feed.selectAllChains')}
      </button>
    </div>
  );
}
```

- [ ] **Step 3: Write failing SidePanelApp persistence tests**

Use the existing fake `LocalPreferences` storage to cover:

1. stored `mutedChains: ['base', 'unknown']` initializes visible chains without Base and never renders Unknown;
2. toggling Base calls `updateSettings({ filters: { mutedChains: ['base'] } })` while the feed updates immediately;
3. a rejected update keeps the current session's visible selection;
4. two rapid toggles end with the latest full muted set;
5. the empty-state select-all action writes `mutedChains: []`;
6. a persistence failure streak emits one warning, and a successful write resets the warning gate;
7. changing chain visibility does not update `notifications.soundEnabled`.

- [ ] **Step 4: Run focused tests and verify failures**

Run: `corepack pnpm vitest run tests/unit/HistoryFeed.test.tsx tests/unit/SidePanelApp.test.tsx`

Expected: FAIL because settings are not mapped to visible chains and HistoryFeed lacks the new props.

- [ ] **Step 5: Initialize filter state from persisted settings**

When `preferences.getSettings()` resolves, derive visible chains with `toVisibleChains(next.filters.mutedChains)` and update both `settings` and `filters.visibleChains`. Do not store `unknown` in the visible array.

- [ ] **Step 6: Add one SidePanel filter-update boundary**

Create a `chainPersistenceFailureReportedRef` boolean ref and a callback that always updates transient filters immediately. When `visibleChains` changed, compute `toMutedChains(next.visibleChains)` and enqueue:

```ts
void preferences
  .updateSettings({ filters: { mutedChains } })
  .then((nextSettings) => {
    chainPersistenceFailureReportedRef.current = false;
    setSettings(nextSettings);
  })
  .catch(() => {
    if (!chainPersistenceFailureReportedRef.current) {
      chainPersistenceFailureReportedRef.current = true;
      console.warn('[chain-filter] failed to persist chain visibility');
    }
  });
```

The existing `LocalPreferences.updateQueue` provides ordered writes. Do not roll back `filters` on rejection. The boolean bounds diagnostics to one warning per consecutive failure streak without storing user data. Pass this callback to `FeedFilterPopover` instead of raw `setFilters`.

- [ ] **Step 7: Wire the dedicated empty-state recovery**

Pass:

```tsx
noChainsSelected={filters.visibleChains.length === 0}
onSelectAllChains={() => handleFiltersChange({
  ...filters,
  visibleChains: [...FILTERABLE_CHAINS],
})}
```

- [ ] **Step 8: Run persistence, feed, and local-preferences tests**

Run: `corepack pnpm vitest run tests/unit/SidePanelApp.test.tsx tests/unit/HistoryFeed.test.tsx tests/unit/local-preferences.test.ts`

Expected: all three files pass.

- [ ] **Step 9: Commit persistence and empty-state integration**

```bash
git add src/sidepanel/SidePanelApp.tsx src/popup/HistoryFeed.tsx tests/unit/SidePanelApp.test.tsx tests/unit/HistoryFeed.test.tsx
git commit -m "feat: persist chain visibility filters"
```

### Task 5: Real Extension Regression Coverage

**Files:**
- Modify: `tests/e2e/live-feed.spec.ts`

- [ ] **Step 1: Add distinct live fixtures for BSC, Solana, and Unknown**

Reuse the established activity fixture shape with unique IDs, valid addresses for BSC/Solana, and an unmapped `networkId` for Unknown. Keep action and market-cap values controlled so existing action/MC filters do not hide the rows.

- [ ] **Step 2: Add a failing E2E test for filtering, persistence, and recovery**

The test must:

1. emit BSC and Solana events and verify both cards;
2. open the filter popover and click the BSC chain button;
3. verify BSC disappears and Solana remains;
4. close and reopen the Side Panel target (or reload the extension target using the existing harness) and verify BSC remains disabled;
5. click `Deselect all` and verify the dedicated empty state;
6. click `Select all chains` and verify retained BSC and Solana history returns;
7. emit Unknown and verify it never renders.

- [ ] **Step 3: Add a hidden-chain sound independence assertion**

Enable global buy sound, disable BSC, capture the real offscreen controller play count, emit a new BSC buy, and assert the play count increases once even though the BSC card is absent.

- [ ] **Step 4: Build first, then run the E2E file**

Run: `corepack pnpm build && corepack pnpm playwright test tests/e2e/live-feed.spec.ts`

Expected: all extension E2E tests pass. Building first is mandatory because Playwright loads `.output/chrome-mv3`.

- [ ] **Step 5: Commit E2E coverage**

```bash
git add tests/e2e/live-feed.spec.ts
git commit -m "test: cover persistent chain visibility"
```

### Task 6: Full Verification and Release Artifact Check

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run type checking and the complete Vitest suite**

Run: `corepack pnpm exec tsc --noEmit && corepack pnpm vitest run`

Expected: TypeScript exits 0 and all test files pass.

- [ ] **Step 2: Build fresh output and run all browser tests**

Run: `corepack pnpm build && corepack pnpm playwright test`

Expected: production build exits 0 and all Playwright tests pass.

- [ ] **Step 3: Generate and verify the local package**

Run: `corepack pnpm package:local`

Expected: creates `.output/releases/Fomo-Live-Feed-v0.2.0-chrome.zip` and its `.sha256` sidecar.

Run from `.output/releases`: `shasum -a 256 -c Fomo-Live-Feed-v0.2.0-chrome.zip.sha256`

Expected: `Fomo-Live-Feed-v0.2.0-chrome.zip: OK`.

- [ ] **Step 4: Inspect the final diff and working tree**

Run: `git diff --check && git status -sb && git log --oneline --decorate -8`

Expected: no whitespace errors; only the user's pre-existing `README.md` and `ROADMAP.md` changes remain outside the feature commits.

- [ ] **Step 5: Perform targeted manual Chrome checks**

Load `.output/chrome-mv3` as an unpacked extension and confirm:

- the two-column selector fits at the minimum Side Panel width without horizontal clipping;
- light and dark themes preserve selected/unselected contrast;
- keyboard Tab/Space operation and focus rings work for every chain and bulk button;
- restarting Chrome restores the last selection;
- a hidden-chain live buy remains audible while its card stays hidden.
