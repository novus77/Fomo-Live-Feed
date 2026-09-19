# Pump Unified Feed UI and Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the approved compact Fomo + Pump feed UI with official source artwork, synchronized source selection, source-aware card badges, and an inclusive buy-amount range filter without changing the existing three-row card layout.

**Architecture:** This plan is the UI/filter companion to `docs/superpowers/plans/2026-09-09-pump-following-live-feed.md`. It starts after that plan's canonical multi-source event model and Pump ingestion path exist. Source and amount filters remain bounded in-memory post-filters, matching the current market-cap design; one shared source-icon component and one shared filter state feed the toolbar, popover, cards, side panel, floating window, and document PiP.

**Tech Stack:** TypeScript 5.9, React 19, WXT 0.21, Zod 4, Vitest 3, Testing Library, Playwright.

---

## Preconditions and file map

- Prerequisite: Tasks 1–7 of `docs/superpowers/plans/2026-09-09-pump-following-live-feed.md` have passed, including the feasibility gate and canonical `ActivitySource`/multi-source event shape.
- Create `public/sources/fomo.svg`: local official Fomo artwork.
- Create `public/sources/pump.png`: local official Pump artwork.
- Create `src/sidepanel/SourceIcon.tsx`: the only mapping from `ActivitySource` to artwork and accessible label.
- Create `src/sidepanel/SourceBadgeGroup.tsx`: single/dual badge rendering and selected-source projection.
- Create `src/sidepanel/SourceStatus.tsx`: independent Fomo/Pump connection indicators.
- Create `src/sidepanel/FeedQuickFilters.tsx`: compact action and source controls under the header.
- Create `src/sidepanel/buy-amount-range.ts`: strict raw-USD draft parser.
- Modify `src/popup/event-query.ts`: source and buy-amount filter state and predicates.
- Modify `src/domain/activity.ts`: one backward-compatible event-source accessor.
- Modify `src/sidepanel/FeedFilterPopover.tsx`: synchronized source controls and buy range inputs.
- Modify `src/sidepanel/SidePanelApp.tsx`: own and distribute the shared filter state.
- Modify `src/popup/HistoryFeed.tsx`: pass the selected source to cards.
- Modify `src/popup/EventCard.tsx`: render projected source badges without changing card row order.
- Modify `entrypoints/sidepanel/sidepanel.css`: approved compact styling and density contract.
- Modify `src/i18n/catalog.ts`: English and Chinese labels, summaries, and errors.
- Extend focused unit tests and `tests/e2e/live-feed.spec.ts`.

## Required semantics

- `source === undefined` means All; a dual-source event shows both badges.
- `source === 'fomo'` or `'pump'` matches any event containing that source and shows only that selected badge on the card.
- Filtering never mutates the event's stored `sources`, changes deduplication, or changes connection state.
- Buy amount bounds are inclusive and expressed in raw USD, not K.
- An active buy range applies only to `buy`; sell, thesis, transfer, and withdraw remain visible if their other filters match.
- A buy with missing/NaN/Infinity `usdAmount` is hidden while either amount bound is active.
- Blank bounds are open-ended, zero is valid, and a reversed range retains the last valid applied filter.
- The toolbar and popover edit the same `PopupEventFilters` object.
- Filter choices are session-local in this release, like the current market-cap range. Existing persisted chain visibility remains unchanged.
- Source connection icons always show observer status and are not hidden by source filtering.

### Task 1: Install official source artwork behind one component

**Files:**
- Create: `public/sources/fomo.svg`
- Create: `public/sources/pump.png`
- Create: `src/sidepanel/SourceIcon.tsx`
- Test: `tests/unit/SourceIcon.test.tsx`
- Test: `tests/unit/manifest-config.test.ts`

- [ ] **Step 1: Write the failing component test**

```tsx
it.each([
  ['fomo', '/sources/fomo.svg', 'Fomo'],
  ['pump', '/sources/pump.png', 'Pump'],
] as const)('maps %s to its bundled official asset', (source, src, label) => {
  render(<SourceIcon source={source} />);
  expect(screen.getByRole('img', { name: label })).toHaveAttribute('src', src);
});
```

- [ ] **Step 2: Run the test and verify the missing component failure**

Run: `pnpm vitest run tests/unit/SourceIcon.test.tsx`

Expected: FAIL because `src/sidepanel/SourceIcon.tsx` does not exist.

- [ ] **Step 3: Copy the already verified official assets into public runtime paths**

Copy `designs/pump-unified-feed-prototype/assets/fomo-official.svg` to
`public/sources/fomo.svg` and
`designs/pump-unified-feed-prototype/assets/pump-official.png` to
`public/sources/pump.png`. Preserve bytes; do not hotlink or rasterize the SVG.

- [ ] **Step 4: Implement the exhaustive source-icon component**

```tsx
import type { ActivitySource } from '../domain/activity';

const SOURCE_ASSETS = {
  fomo: { src: '/sources/fomo.svg', label: 'Fomo' },
  pump: { src: '/sources/pump.png', label: 'Pump' },
} as const satisfies Record<ActivitySource, { src: string; label: string }>;

export function SourceIcon({ source }: { source: ActivitySource }) {
  const asset = SOURCE_ASSETS[source];
  return <img className={`source-icon source-icon-${source}`} src={asset.src} alt={asset.label} />;
}
```

- [ ] **Step 5: Run asset and component tests**

Run: `pnpm vitest run tests/unit/SourceIcon.test.tsx tests/unit/manifest-config.test.ts`

Expected: PASS and both files are copied into the WXT output.

- [ ] **Step 6: Create checkpoint commit after authorization**

```bash
git add public/sources src/sidepanel/SourceIcon.tsx tests/unit/SourceIcon.test.tsx tests/unit/manifest-config.test.ts
git commit -m "feat: add official source artwork"
```

### Task 2: Add source and buy-amount filter semantics

**Files:**
- Create: `src/sidepanel/buy-amount-range.ts`
- Modify: `src/domain/activity.ts`
- Modify: `src/popup/event-query.ts`
- Test: `tests/unit/buy-amount-range.test.ts`
- Test: `tests/unit/event-query.test.ts`

- [ ] **Step 1: Add failing range parser tests**

```ts
expect(parseBuyAmountRange('', '')).toEqual({ ok: true, minimum: undefined, maximum: undefined });
expect(parseBuyAmountRange('5', '')).toEqual({ ok: true, minimum: 5, maximum: undefined });
expect(parseBuyAmountRange('0', '10.5')).toEqual({ ok: true, minimum: 0, maximum: 10.5 });
expect(parseBuyAmountRange('-1', '')).toEqual({ ok: false, reason: 'invalid-number' });
expect(parseBuyAmountRange('10', '5')).toEqual({ ok: false, reason: 'reversed-range' });
```

- [ ] **Step 2: Add failing post-filter tests**

```ts
const pumpOnly = { ...DEFAULT_FILTERS, source: 'pump' as const };
expect(matchesPostFilters(makeMultiSourceEvent(['fomo', 'pump']), pumpOnly, EMPTY_ANNOTATIONS)).toBe(true);
expect(matchesPostFilters(makeMultiSourceEvent(['fomo']), pumpOnly, EMPTY_ANNOTATIONS)).toBe(false);

const minimumFive = { ...DEFAULT_FILTERS, minimumBuyAmount: 5 };
expect(matchesPostFilters(makeEvent({ action: 'buy', usdAmount: 4.99 }), minimumFive, EMPTY_ANNOTATIONS)).toBe(false);
expect(matchesPostFilters(makeEvent({ action: 'buy', usdAmount: 5 }), minimumFive, EMPTY_ANNOTATIONS)).toBe(true);
expect(matchesPostFilters(makeEvent({ action: 'sell', usdAmount: 1 }), minimumFive, EMPTY_ANNOTATIONS)).toBe(true);
expect(matchesPostFilters(makeEvent({ action: 'thesis', usdAmount: undefined }), minimumFive, EMPTY_ANNOTATIONS)).toBe(true);
expect(matchesPostFilters(makeEvent({ action: 'buy', usdAmount: undefined }), minimumFive, EMPTY_ANNOTATIONS)).toBe(false);
```

- [ ] **Step 3: Implement strict raw-USD parsing**

```ts
export type BuyAmountRangeResult =
  | { ok: true; minimum: number | undefined; maximum: number | undefined }
  | { ok: false; reason: 'invalid-number' | 'reversed-range' };

export function parseBuyAmountRange(minimumDraft: string, maximumDraft: string): BuyAmountRangeResult {
  const parse = (draft: string): number | undefined | null => {
    if (draft.trim() === '') return undefined;
    const value = Number(draft);
    return Number.isFinite(value) && value >= 0 ? value : null;
  };
  const minimum = parse(minimumDraft);
  const maximum = parse(maximumDraft);
  if (minimum === null || maximum === null) return { ok: false, reason: 'invalid-number' };
  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    return { ok: false, reason: 'reversed-range' };
  }
  return { ok: true, minimum, maximum };
}
```

- [ ] **Step 4: Extend `PopupEventFilters` and post-filtering**

Add `source`, `minimumBuyAmount`, and `maximumBuyAmount` to `PopupEventFilters`
and `DEFAULT_FILTERS`. Count source and buy range as separate active groups.
Add one backward-compatible source accessor to `src/domain/activity.ts`; never
read a legacy `source` field directly in UI code.

```ts
export function eventSources(event: TradeEvent): readonly ActivitySource[] {
  return event.schemaVersion === 1 ? ['fomo'] : event.sources;
}

const hasBuyRange = filters.minimumBuyAmount !== undefined
  || filters.maximumBuyAmount !== undefined;

if (filters.source !== undefined && !eventSources(event).includes(filters.source)) return false;
if (event.action === 'buy' && hasBuyRange) {
  if (typeof event.usdAmount !== 'number' || !Number.isFinite(event.usdAmount)) return false;
  if (filters.minimumBuyAmount !== undefined && event.usdAmount < filters.minimumBuyAmount) return false;
  if (filters.maximumBuyAmount !== undefined && event.usdAmount > filters.maximumBuyAmount) return false;
}
```

- [ ] **Step 5: Run focused filter tests**

Run: `pnpm vitest run tests/unit/buy-amount-range.test.ts tests/unit/event-query.test.ts`

Expected: PASS for inclusive bounds, missing amounts, dual-source matching, and unaffected non-buy actions.

- [ ] **Step 6: Create checkpoint commit after authorization**

```bash
git add src/domain/activity.ts src/sidepanel/buy-amount-range.ts src/popup/event-query.ts tests/unit/buy-amount-range.test.ts tests/unit/event-query.test.ts
git commit -m "feat: add source and buy amount filters"
```

### Task 3: Build synchronized quick and full filter controls

**Files:**
- Create: `src/sidepanel/FeedQuickFilters.tsx`
- Modify: `src/sidepanel/FeedFilterPopover.tsx`
- Modify: `src/i18n/catalog.ts`
- Test: `tests/unit/FeedQuickFilters.test.tsx`
- Test: `tests/unit/FeedFilterPopover.test.tsx`

- [ ] **Step 1: Add failing source-control tests**

```tsx
fireEvent.click(screen.getByRole('button', { name: 'Pump only' }));
expect(onFiltersChange).toHaveBeenLastCalledWith(expect.objectContaining({ source: 'pump' }));
fireEvent.click(screen.getByRole('button', { name: 'All sources' }));
expect(onFiltersChange).toHaveBeenLastCalledWith(expect.objectContaining({ source: undefined }));
```

Assert the quick toolbar and popover expose exclusive `aria-pressed` states,
32px minimum hit targets, official icons, and the same source value.

- [ ] **Step 2: Add failing buy-range interaction tests**

```tsx
fireEvent.change(screen.getByRole('textbox', { name: 'Minimum buy amount in USD' }), {
  target: { value: '5' },
});
fireEvent.blur(screen.getByRole('textbox', { name: 'Minimum buy amount in USD' }));
expect(onFiltersChange).toHaveBeenLastCalledWith(expect.objectContaining({ minimumBuyAmount: 5 }));
```

Also assert reversed input shows an alert and does not replace the last valid
filter; Reset clears source, amount, market-cap, action, and chain filters.

- [ ] **Step 3: Implement `FeedQuickFilters` as a controlled component**

```tsx
export interface FeedQuickFiltersProps {
  filters: PopupEventFilters;
  onFiltersChange(filters: PopupEventFilters): void;
}

const SOURCES = [undefined, 'fomo', 'pump'] as const;
```

Render action toggles and the three exclusive source buttons in the approved
order. Use `SourceIcon` for Fomo and Pump. Do not own duplicate local state.

- [ ] **Step 4: Extend `FeedFilterPopover`**

Use controlled drafts matching the existing market-cap pattern. Apply valid
drafts on blur or Enter. Use `$` units, not `K`, and include the range in the
filter-trigger summary, for example `Buy ≥ $5` or `Buy $5–$100`.

- [ ] **Step 5: Add localized strings**

Add matching English and Simplified Chinese catalog entries for All sources,
Fomo only, Pump only, buy amount range, min/max labels, invalid number,
reversed range, and filter summary. Keep source brand names untranslated.

- [ ] **Step 6: Run component and catalog tests**

Run: `pnpm vitest run tests/unit/FeedQuickFilters.test.tsx tests/unit/FeedFilterPopover.test.tsx tests/unit/i18n-catalog.test.ts`

Expected: PASS.

- [ ] **Step 7: Create checkpoint commit after authorization**

```bash
git add src/sidepanel/FeedQuickFilters.tsx src/sidepanel/FeedFilterPopover.tsx src/i18n/catalog.ts tests/unit/FeedQuickFilters.test.tsx tests/unit/FeedFilterPopover.test.tsx tests/unit/i18n-catalog.test.ts
git commit -m "feat: add unified feed filter controls"
```

### Task 4: Project event sources into compact card badges

**Files:**
- Create: `src/sidepanel/SourceBadgeGroup.tsx`
- Modify: `src/popup/EventCard.tsx`
- Modify: `src/popup/HistoryFeed.tsx`
- Test: `tests/unit/SourceBadgeGroup.test.tsx`
- Test: `tests/unit/EventCard.test.tsx`
- Test: `tests/unit/HistoryFeed.test.tsx`

- [ ] **Step 1: Add failing badge-projection tests**

```tsx
expect(renderBadges(['fomo', 'pump'], undefined)).toEqual(['Fomo', 'Pump']);
expect(renderBadges(['fomo', 'pump'], 'fomo')).toEqual(['Fomo']);
expect(renderBadges(['fomo', 'pump'], 'pump')).toEqual(['Pump']);
```

The test must check both the avatar-overlap group and the right-side card group,
including tooltips and accessible names.

- [ ] **Step 2: Implement deterministic projection**

```ts
export function visibleEventSources(
  sources: readonly ActivitySource[],
  selected: ActivitySource | undefined,
): readonly ActivitySource[] {
  return selected === undefined ? sources : sources.filter((source) => source === selected);
}
```

Deduplicate sources while preserving the canonical Fomo-then-Pump order. Return
no duplicate nodes even if malformed input repeats a source.

- [ ] **Step 3: Thread `selectedSource` through the feed**

Add `selectedSource` to `HistoryFeedProps` and `EventCardProps`. Pass
`filters.source` from `SidePanelApp` to `HistoryFeed`, then to every card.

- [ ] **Step 4: Preserve the three-row card DOM contract**

Place source badges inside `.event-card-header`; do not create a sibling row.
Keep this exact structural order:

```tsx
<header className="event-card-header">...</header>
<div className="event-action-line">...</div>
{event.thesis !== undefined && <TranslatedOpinion ... />}
<footer className="event-footer">...</footer>
```

- [ ] **Step 5: Run badge and card tests**

Run: `pnpm vitest run tests/unit/SourceBadgeGroup.test.tsx tests/unit/EventCard.test.tsx tests/unit/HistoryFeed.test.tsx`

Expected: PASS; All/Fomo/Pump badge counts match the approved prototype.

- [ ] **Step 6: Create checkpoint commit after authorization**

```bash
git add src/sidepanel/SourceBadgeGroup.tsx src/popup/EventCard.tsx src/popup/HistoryFeed.tsx tests/unit/SourceBadgeGroup.test.tsx tests/unit/EventCard.test.tsx tests/unit/HistoryFeed.test.tsx
git commit -m "feat: render source-aware event badges"
```

### Task 5: Wire the approved layout into every feed surface

**Files:**
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `entrypoints/sidepanel/sidepanel.css`
- Test: `tests/unit/SidePanelApp.test.tsx`
- Test: `tests/unit/FloatPanelApp.test.tsx`
- Test: `tests/unit/document-pip.test.ts`
- Test: `tests/unit/sidepanel-style-contract.test.ts`

- [ ] **Step 1: Add failing surface-composition tests**

Assert the quick filter row appears directly below the header on the side
panel, floating surface, and PiP feed. `FloatingSurfaceHost` and `PipFeedRoot`
already reuse `SidePanelApp`, so no duplicate UI implementation is added.
Changing a source in one mounted surface changes its feed immediately;
switching surfaces retains the currently loaded events and obtains the latest
filter defaults without duplicating readers.

- [ ] **Step 2: Add failing density-contract assertions**

```ts
expect(css).toMatch(/\.event-card\s*\{[^}]*padding:\s*7px 10px/s);
expect(css).toMatch(/\.event-card-header/);
expect(css).toMatch(/\.event-action-line/);
expect(css).toMatch(/\.event-footer/);
```

Keep the existing card-height regression fixture and require the same or more
visible cards at 420×760. Source badges must not increase row height.

- [ ] **Step 3: Compose the controlled toolbar**

Render:

```tsx
<FeedQuickFilters filters={filters} onFiltersChange={handleFiltersChange} />
```

between `.sidepanel-header` and `.sidepanel-feed`. The filter funnel remains in
the header and opens the full popover. Both controls share `filters` and
`handleFiltersChange`.

- [ ] **Step 4: Apply approved compact CSS**

Use the prototype tokens for spacing and source-badge overlap, but retain the
production light/dark variables, action-colored borders, financial custom
properties, translation block, annotation editor, and CA alignment. Do not
copy prototype colors directly over theme variables.

- [ ] **Step 5: Run all surface and style tests**

Run: `pnpm vitest run tests/unit/SidePanelApp.test.tsx tests/unit/FloatPanelApp.test.tsx tests/unit/document-pip.test.ts tests/unit/sidepanel-style-contract.test.ts`

Expected: PASS at both themes and all three surfaces.

- [ ] **Step 6: Create checkpoint commit after authorization**

```bash
git add src/sidepanel/SidePanelApp.tsx entrypoints/sidepanel/sidepanel.css tests/unit/SidePanelApp.test.tsx tests/unit/FloatPanelApp.test.tsx tests/unit/document-pip.test.ts tests/unit/sidepanel-style-contract.test.ts
git commit -m "feat: apply compact unified feed layout"
```

### Task 6: Verify source connection states stay independent from filtering

**Files:**
- Create: `src/sidepanel/SourceStatus.tsx`
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Test: `tests/unit/SourceStatus.test.tsx`
- Test: `tests/unit/SidePanelApp.test.tsx`

- [ ] **Step 1: Add failing independent-state tests**

Cover Fomo connected/Pump disconnected, Pump connected/Fomo disconnected, both
connected, Pump waiting for a new followed-trader trade, and malformed Pump
protocol. Selecting Fomo or Pump must not hide either header connection status.

- [ ] **Step 2: Render compact status icons from worker state**

Use `SourceIcon` plus a semantic status dot. Tooltips must distinguish
connected, page open but unavailable, disconnected, waiting, and unsupported
protocol. Never infer Pump login from page presence alone.

- [ ] **Step 3: Run connection UI tests**

Run: `pnpm vitest run tests/unit/SourceStatus.test.tsx tests/unit/SidePanelApp.test.tsx tests/unit/connection-state.test.ts`

Expected: PASS.

- [ ] **Step 4: Create checkpoint commit after authorization**

```bash
git add src/sidepanel/SourceStatus.tsx src/sidepanel/SidePanelApp.tsx tests/unit/SourceStatus.test.tsx tests/unit/SidePanelApp.test.tsx tests/unit/connection-state.test.ts
git commit -m "feat: show independent source status"
```

### Task 7: Add browser-level acceptance coverage

**Files:**
- Modify: `tests/e2e/fixtures/fomo-page.html`
- Create: `tests/e2e/fixtures/pump-page.html`
- Modify: `tests/e2e/fixture-server.ts`
- Modify: `tests/e2e/live-feed.spec.ts`

- [ ] **Step 1: Add deterministic single- and dual-source fixtures**

Provide one Fomo-only buy, one Pump-only buy, one dual-source buy observed by
both fixtures, one `$0.42` buy, one `$5.00` buy, one sell, and one thesis. Use
fixed timestamps and local assets; never contact production services.

- [ ] **Step 2: Add source-selection scenarios**

Assert All renders the dual event once with two badges, Fomo renders it once
with only Fomo, Pump renders it once with only Pump, and switching filters never
changes stored source metadata.

- [ ] **Step 3: Add buy-range scenarios**

Set minimum `$5`; assert `$0.42` is hidden, `$5.00` remains, and sell/thesis
remain. Cover maximum-only, inclusive upper bound, missing buy amount, reversed
range error, and Reset.

- [ ] **Step 4: Cover all surfaces**

Repeat the essential All/Pump and minimum-amount assertions after switching to
the floating window and after opening document PiP. Assert only one feed surface
owns read receipts.

- [ ] **Step 5: Run E2E**

Run: `pnpm playwright test tests/e2e/live-feed.spec.ts`

Expected: PASS with no external network requests.

- [ ] **Step 6: Create checkpoint commit after authorization**

```bash
git add tests/e2e/fixtures/fomo-page.html tests/e2e/fixtures/pump-page.html tests/e2e/fixture-server.ts tests/e2e/live-feed.spec.ts
git commit -m "test: cover unified source and amount filters"
```

### Task 8: Full regression, build, and manual acceptance

**Files:**
- Modify only files required by failures attributable to this feature.

- [ ] **Step 1: Protect the pre-existing dirty worktree**

Run: `git status --short`

Expected: identify and preserve the existing changes in
`src/fomo/dom-activity-observer.ts`, `src/storage/database.ts`,
`tests/unit/event-repository.test.ts`, and
`tests/unit/fomo-dom-activity-observer.test.ts`. Do not reset or bundle unrelated
changes into feature commits.

- [ ] **Step 2: Run formatting and static verification**

Run: `git diff --check`

Expected: no whitespace errors.

Run: `pnpm typecheck`

Expected: PASS.

- [ ] **Step 3: Run the full unit/integration suite**

Run: `pnpm test`

Expected: PASS.

- [ ] **Step 4: Build the extension**

Run: `pnpm build`

Expected: PASS; the manifest contains both Pump content scripts and both local
source assets.

- [ ] **Step 5: Run the full browser suite**

Run: `pnpm test:e2e`

Expected: PASS.

- [ ] **Step 6: Produce a local install package**

Run: `pnpm package:local`

Expected: PASS and a new Chrome package under `.output/releases/`.

- [ ] **Step 7: Perform manual acceptance**

With logged-in Fomo and Pump tabs open, verify new-only Pump events, All/Fomo/
Pump source switching, exact card badges, `$5` minimum buy filtering, market-cap
and chain filter composition, annotation editing, local translation, buy sound,
token/profile navigation, side panel, floating window, document PiP, both
themes, disconnected history, and no card-height regression.

## Self-review

- The plan covers every approved prototype change: exact source badge
  projection, buy amount range, official icons, synchronized controls, and the
  compact three-row layout.
- Source vocabulary and event types match the Pump data plan.
- Amount bounds are raw USD everywhere; market-cap bounds remain K-based.
- Non-buy actions remain unaffected by the buy amount range.
- Filter selection never changes source connection status or stored event
  provenance.
- No new database index, authentication layer, market-data cache, history
  import, or per-trader Pump polling is introduced.
- All implementation steps name exact files, commands, expected results, and
  testable behavior; no placeholder work remains.
