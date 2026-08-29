# Event Market Cap Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Display the amount and event-associated market cap already present on activity events, while omitting missing financial fields instead of rendering `Unavailable`.

**Architecture:** Keep the existing event schema, ingest pipeline, storage, and shared `EventCard`. Add conditional presentation at the card boundary so missing optional values never reach `formatUsd`; reuse `formatUsd` for valid numbers, including zero. Add a dedicated inline market-cap element and narrow-width wrapping styles without adding network requests, caches, permissions, or data migrations.

**Tech Stack:** TypeScript 5.9, React 19, WXT, Vitest, Testing Library, Playwright, CSS

**Design:** `docs/superpowers/specs/2026-08-29-event-market-cap-card-design.md`

**Repository note:** The worktree already contains unrelated uncommitted changes, including `tests/unit/popup-worker-boundary.test.ts` and translation fixes. Preserve them and do not stage or commit without explicit user authorization.

---

## File Map

- Modify `src/popup/EventCard.tsx`: conditionally render optional event amount and event market cap.
- Modify `entrypoints/sidepanel/sidepanel.css`: style the market-cap label and permit safe wrapping at narrow widths.
- Modify `tests/unit/EventCard.test.tsx`: lock the four missing-data combinations, zero semantics, and unchanged card controls.
- Modify `tests/e2e/live-feed.spec.ts`: verify the fixture's event market cap and the 280 px layout in a production extension.
- Reuse `tests/fixtures/fomo-frames.ts`: its existing buy fixture already contains `usdAmount: 1250.5` and `marketCap: 4200000`; no fixture mutation is needed.

No changes are planned for `TradeEventV1`, IndexedDB, normalization, messaging, manifest permissions, translation, or localization catalogs.

---

### Task 1: Lock the optional financial-field contract in card tests

**Files:**
- Modify: `tests/unit/EventCard.test.tsx`
- Test: `tests/unit/EventCard.test.tsx`

- [ ] **Step 1: Add a market-cap default to the shared test event**

Add `marketCap: 4_200_000` next to `usdAmount` in `makeEvent` so the normal card represents the production buy/sell shape:

```tsx
    action: 'buy',
    usdAmount: 1250.5,
    marketCap: 4_200_000,
    occurredAt: NOW - 60_000,
```

- [ ] **Step 2: Write failing tests for complete and partial data**

Add these tests inside `describe('EventCard', ...)` after the identity test:

```tsx
  it('shows event amount and event market cap when both exist', () => {
    const { container } = renderCard(makeEvent({
      usdAmount: 1_250.5,
      marketCap: 4_200_000,
    }));

    expect(container.querySelector('.event-amount')).toHaveTextContent('$1.25K');
    expect(container.querySelector('.event-market-cap')).toHaveTextContent('MC: $4.2M');
  });

  it('shows only the event amount when market cap is missing', () => {
    const { container } = renderCard(makeEvent({
      usdAmount: 500,
      marketCap: undefined,
    }));

    expect(container.querySelector('.event-amount')).toHaveTextContent('$500');
    expect(container.querySelector('.event-market-cap')).not.toBeInTheDocument();
  });

  it('shows only event market cap when amount is missing', () => {
    const { container } = renderCard(makeEvent({
      usdAmount: undefined,
      marketCap: 442_000,
    }));

    expect(container.querySelector('.event-amount')).not.toBeInTheDocument();
    expect(container.querySelector('.event-market-cap')).toHaveTextContent('MC: $442K');
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
  });

  it('omits both financial fields for an opinion without event metrics', () => {
    const { container } = renderCard(makeEvent({
      action: 'thesis',
      thesis: 'Bots Bots FREE THE BOTS!',
      usdAmount: undefined,
      marketCap: undefined,
    }));

    expect(container.querySelector('.event-amount')).not.toBeInTheDocument();
    expect(container.querySelector('.event-market-cap')).not.toBeInTheDocument();
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
    expect(screen.getByText('Bots Bots FREE THE BOTS!')).toBeInTheDocument();
  });
```

- [ ] **Step 3: Write a failing test that distinguishes zero from missing**

```tsx
  it('renders real zero values instead of treating them as missing', () => {
    const { container } = renderCard(makeEvent({ usdAmount: 0, marketCap: 0 }));

    expect(container.querySelector('.event-amount')).toHaveTextContent('$0');
    expect(container.querySelector('.event-market-cap')).toHaveTextContent('MC: $0');
  });
```

- [ ] **Step 4: Run the focused unit test and verify the expected RED state**

Run:

```bash
corepack pnpm test tests/unit/EventCard.test.tsx
```

Expected: the new tests fail because the existing card always renders `.event-amount`, has no `.event-market-cap`, and produces `Unavailable` for missing amounts. Existing tests remain passing.

---

### Task 2: Implement conditional amount and event market-cap rendering

**Files:**
- Modify: `src/popup/EventCard.tsx`
- Test: `tests/unit/EventCard.test.tsx`

- [ ] **Step 1: Add an explicit finite-number guard near the component**

Place this helper after `EventCardProps` and before `EventCard`:

```tsx
const hasFinancialValue = (value: number | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value);
```

Although runtime event validation already requires finite numbers, this
component-boundary guard prevents malformed legacy/injected values from
rendering an orphan label. Do not use truthiness because zero is valid.

- [ ] **Step 2: Replace the unconditional amount with conditional financial fields**

In `.event-action-line`, replace:

```tsx
        <span className="event-amount">{formatUsd(event.usdAmount)}</span>
        <span className="event-time">{formatRelativeTime(event.occurredAt, now())}</span>
```

with:

```tsx
        <span className="event-financials">
          {hasFinancialValue(event.usdAmount) && (
            <span className="event-amount">{formatUsd(event.usdAmount)}</span>
          )}
          {hasFinancialValue(event.marketCap) && (
            <span className="event-market-cap">
              <span className="event-market-cap-label">MC:</span>{' '}
              {formatUsd(event.marketCap)}
            </span>
          )}
        </span>
        <span className="event-time">{formatRelativeTime(event.occurredAt, now())}</span>
```

The wrapper stays present to own layout spacing. It contains no placeholder
text when both values are absent. Do not change `formatUsd`: other surfaces
intentionally use its `Unavailable` fallback.

- [ ] **Step 3: Run the focused unit test and verify GREEN**

Run:

```bash
corepack pnpm test tests/unit/EventCard.test.tsx
```

Expected: all `EventCard` tests pass, including all four missing-data
combinations and real zero values.

- [ ] **Step 4: Run directly related presentation tests**

Run:

```bash
corepack pnpm test tests/unit/EventCard.test.tsx tests/unit/HistoryFeed.test.tsx tests/unit/format.test.ts
```

Expected: all selected tests pass. Translation and address-copy assertions
remain unchanged.

---

### Task 3: Add narrow-width-safe card styling

**Files:**
- Modify: `entrypoints/sidepanel/sidepanel.css`
- Test: `tests/e2e/live-feed.spec.ts`

- [ ] **Step 1: Replace amount auto-spacing with a grouped financial layout**

Replace the existing `.event-amount` rule:

```css
.event-amount {
  margin-left: auto;
}
```

with:

```css
.event-financials {
  display: inline-flex;
  align-items: baseline;
  gap: 8px;
  margin-left: auto;
  min-width: 0;
  white-space: nowrap;
}

.event-amount {
  color: var(--text-primary, #f8fafc);
  font-variant-numeric: tabular-nums;
}

.event-market-cap {
  color: var(--text-secondary, #94a3b8);
  font-variant-numeric: tabular-nums;
}

.event-market-cap-label {
  color: var(--text-muted, #64748b);
}
```

- [ ] **Step 2: Allow the action line to wrap without detaching its contents**

Extend `.event-action-line` with `flex-wrap: wrap` and keep the existing gap:

```css
.event-action-line {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
}
```

Ensure `.event-time` remains non-wrapping:

```css
.event-time {
  color: #64748b;
  font-size: 11px;
  white-space: nowrap;
}
```

Do not introduce absolute positioning or fixed widths; the existing 280 px
layout test must remain authoritative.

- [ ] **Step 3: Run typecheck and focused tests after the CSS change**

Run:

```bash
corepack pnpm typecheck
corepack pnpm test tests/unit/EventCard.test.tsx tests/unit/HistoryFeed.test.tsx
```

Expected: both commands exit successfully.

---

### Task 4: Extend the production-browser acceptance test

**Files:**
- Modify: `tests/e2e/live-feed.spec.ts`
- Reuse: `tests/fixtures/fomo-frames.ts`

- [ ] **Step 1: Add semantic assertions for amount and market cap**

In the main live-feed test, after the panel has rendered the first accepted
`buyFrame`, add:

```ts
    expect(await panel.hasText('$1.25K')).toBe(true);
    expect(await panel.hasText('MC: $4.2M')).toBe(true);
```

These expected values come from the existing fixture fields
`usdAmount: 1250.5` and `marketCap: 4200000`.

- [ ] **Step 2: Strengthen the 280 px layout evaluation**

Extend the object returned from the existing 280 px evaluation with:

```ts
        marketCapsVisible: [...document.querySelectorAll('.event-market-cap')]
          .every((element) => element.getBoundingClientRect().width > 0),
```

Update the TypeScript result type:

```ts
    const layout = await panel.evaluate<{
      overflow: boolean;
      overlap: boolean;
      marketCapsVisible: boolean;
      documentWidth: number;
      bodyWidth: number;
      widest: string;
    }>(`...`);
```

Update the failure condition:

```ts
    if (
      layout === undefined ||
      layout.overflow ||
      layout.overlap ||
      !layout.marketCapsVisible
    ) {
      throw new Error('280px layout failure: ' + JSON.stringify(layout));
    }
```

- [ ] **Step 3: Build the production extension**

Run:

```bash
corepack pnpm build
```

Expected: WXT builds `.output/chrome-mv3` successfully.

- [ ] **Step 4: Run the E2E suite**

Run:

```bash
corepack pnpm test:e2e
```

Expected: the production-extension E2E suite passes, including `MC: $4.2M`
and the 280 px layout check. If the environment cannot launch Chromium, report
that environmental limitation rather than weakening the assertions.

---

### Task 5: Full verification and manual browser handoff

**Files:**
- Verify only; no planned source changes

- [ ] **Step 1: Run whitespace and diff validation**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors. Confirm that only the planned card files plus
pre-existing unrelated worktree changes are present.

- [ ] **Step 2: Run the full local release gate**

Run:

```bash
corepack pnpm check
```

Expected for the feature: typecheck succeeds, card tests pass, and the build
succeeds. At plan-writing time, two pre-existing tests in
`tests/unit/popup-worker-boundary.test.ts` fail because tab removal/navigation
does not yet clear connection state. Report those failures separately if still
present; do not change or disable them as part of this feature.

- [ ] **Step 3: Re-run the focused proof if the unrelated full gate fails**

Run:

```bash
corepack pnpm typecheck
corepack pnpm test tests/unit/EventCard.test.tsx tests/unit/HistoryFeed.test.tsx tests/unit/format.test.ts
corepack pnpm build
```

Expected: every focused command exits successfully. This proves the feature
without misrepresenting the unrelated full-suite status.

- [ ] **Step 4: Update the unpacked extension without changing its ID**

After explicit user authorization to update the installed copy:

1. Identify the exact unpacked source directory in `chrome://extensions`.
2. Back up that directory to a timestamped archive under `/private/tmp`.
3. Copy `.output/chrome-mv3` contents into the same directory.
4. Select **Reload** for Fomo Live Feed.
5. Refresh the existing authenticated Fomo tab once.

Do not remove and re-add the extension because changing the extension ID may
orphan its local history and preferences.

- [ ] **Step 5: Perform a read-only visual acceptance pass**

Verify in the real Side Panel:

- a buy or sell with event data shows amount and `MC:`;
- an opinion without financial data shows neither `Unavailable` nor `MC:`;
- translation, token navigation, profile navigation, and CA copying are still
present;
- normal and narrow panel widths have no horizontal overflow;
- no new host permission or network request was introduced.

Capture the observed examples in the completion report without recording
cookies, headers, tokens, or raw private payloads.

---

## Completion Report Requirements

The implementation handoff must state:

- the exact files changed;
- focused test counts and command results;
- production build and E2E results;
- any remaining unrelated full-suite failures;
- whether the installed unpacked extension was updated and manually verified;
- confirmation that no network request, cache, permission, schema migration,
  or persistent storage was added.

