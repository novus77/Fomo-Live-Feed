# Compact Event Card Header and Address Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move relative time beside the trader name and align the copy control with the contract address to reduce card height and improve visual grouping.

**Architecture:** Keep `EventCard` responsible for event composition and move only the time node into a dedicated first-line identity wrapper. Refine `CopyableAddress` into explicit label, value, and action nodes while preserving its validation and interaction state machine. CSS owns truncation/alignment, and focused unit plus 280px E2E tests lock down DOM placement and geometry.

**Tech Stack:** React, TypeScript, CSS, Vitest, Testing Library, Playwright, WXT

**Repository constraint:** Do not create Git commits unless the user explicitly authorizes them. Preserve all unrelated dirty-worktree changes.

---

## File Map

- Modify `src/popup/EventCard.tsx`: place relative time in the trader-name row and remove it from the action row.
- Modify `src/sidepanel/CopyableAddress.tsx`: split localized CA label from canonical address text without changing copy behavior.
- Modify `entrypoints/sidepanel/sidepanel.css`: implement name/time truncation and address/button alignment.
- Modify `tests/unit/EventCard.test.tsx`: verify time placement and action-row absence.
- Modify `tests/unit/CopyableAddress.test.tsx`: verify split nodes and preserved valid/invalid interactions.
- Modify `tests/e2e/live-feed.spec.ts`: verify 280px geometry and lack of horizontal overflow.

### Task 1: Move Relative Time Into the Trader-Name Row

**Files:**
- Modify: `src/popup/EventCard.tsx`
- Test: `tests/unit/EventCard.test.tsx`

- [ ] **Step 1: Write failing DOM-placement tests**

Add assertions that the name and time share `.event-trader-primary`, the handle remains outside that first-line wrapper, and `.event-action-line` contains no `.event-time`:

```tsx
const primary = container.querySelector('.event-trader-primary');
expect(primary).toHaveTextContent('Trader');
expect(primary?.querySelector('.event-time')).toHaveTextContent('1m ago');
expect(primary?.querySelector('.event-trader-handle')).not.toBeInTheDocument();
expect(container.querySelector('.event-action-line .event-time')).not.toBeInTheDocument();
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
corepack pnpm vitest run tests/unit/EventCard.test.tsx
```

Expected: FAIL because `.event-trader-primary` does not exist and `.event-time` is still in `.event-action-line`.

- [ ] **Step 3: Implement the minimal EventCard structure**

Change the identity text to:

```tsx
<span className="event-identity-text">
  <span className="event-trader-primary">
    <span className="event-trader-name">{traderName}</span>
    <span className="event-time">{formatRelativeTime(event.occurredAt, now())}</span>
  </span>
  <span className="event-trader-handle">
    @{event.traderHandle}
    {followers !== undefined && (
      <span className="event-trader-followers">
        {' · '}
        {translate('card.followers', { count: followers })}
      </span>
    )}
  </span>
</span>
```

Remove the `.event-time` span from `.event-action-line`.

- [ ] **Step 4: Verify GREEN and type safety**

Run:

```bash
corepack pnpm vitest run tests/unit/EventCard.test.tsx
corepack pnpm typecheck
```

Expected: all EventCard tests pass and TypeScript exits 0.

### Task 2: Split the CA Label From the Copyable Address

**Files:**
- Modify: `src/sidepanel/CopyableAddress.tsx`
- Test: `tests/unit/CopyableAddress.test.tsx`

- [ ] **Step 1: Write failing structure and behavior tests**

For a valid address, assert separate label/value nodes and unchanged copy semantics:

```tsx
expect(container.querySelector('.copyable-address-label')).toHaveTextContent('CA:');
const value = container.querySelector('.copyable-address-value');
expect(value).toHaveTextContent(CANONICAL);
expect(value).not.toHaveTextContent('CA:');
expect(screen.getByRole('button', { name: /copy full address/i })).toBeInTheDocument();
```

For an invalid address, assert the same separated label/value presentation without interactive roles or a copy button.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
corepack pnpm vitest run tests/unit/CopyableAddress.test.tsx
```

Expected: FAIL because `CA:` and the address currently share one node.

- [ ] **Step 3: Derive the localized label without adding catalog entries**

Use the existing translation template and remove only the known inserted address suffix:

```tsx
const fullAddressLabel = translate('card.caLabel', { address: displayedAddress });
const addressLabel = fullAddressLabel.slice(0, fullAddressLabel.length - displayedAddress.length);
```

For invalid input, derive the label using the untrusted address in the same way. This preserves all locale catalog behavior without hardcoding `CA:` in production code.

- [ ] **Step 4: Render explicit label, value, and button nodes**

For valid addresses, render:

```tsx
<div className="copyable-address" onClick={(event) => event.stopPropagation()}>
  <span className="copyable-address-label">{addressLabel}</span>
  <span className="copyable-address-value" role="button" tabIndex={0} ...>
    {displayedAddress}
  </span>
  <button className="copyable-address-button" ...>...</button>
  {feedback}
</div>
```

For invalid addresses, render `.copyable-address-label` followed by a non-interactive `.copyable-address-value` containing only the untrusted address. Do not render a button.

- [ ] **Step 5: Verify GREEN and regression behavior**

Run:

```bash
corepack pnpm vitest run tests/unit/CopyableAddress.test.tsx
corepack pnpm typecheck
```

Expected: all tests pass; click, keyboard, failure feedback, timer, stale-promise, and unmount tests remain green.

### Task 3: Implement Compact Header and Address Alignment CSS

**Files:**
- Modify: `entrypoints/sidepanel/sidepanel.css`

- [ ] **Step 1: Add first-line name/time layout**

Add:

```css
.event-trader-primary {
  display: flex;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}

.event-trader-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.event-time {
  flex: none;
  white-space: nowrap;
}
```

Keep existing name typography and time colors. Remove no longer relevant action-row positioning rules if present.

- [ ] **Step 2: Replace address flex alignment with a compact grid**

Use:

```css
.copyable-address {
  display: grid;
  grid-template-columns: max-content minmax(0, max-content) max-content;
  align-items: center;
  column-gap: 4px;
  min-width: 0;
}

.copyable-address-label,
.copyable-address-value {
  color: #94a3b8;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
}

.copyable-address-value {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.copyable-address-button {
  align-self: center;
}
```

Ensure feedback occupies a subsequent grid column or otherwise remains readable without displacing the address/button alignment. Preserve existing focus-visible styles and light-theme color behavior by including `.copyable-address-label` where needed.

- [ ] **Step 3: Run static verification**

Run:

```bash
corepack pnpm typecheck
corepack pnpm build
git diff --check
```

Expected: all commands exit 0.

### Task 4: Lock Down the 280px Geometry

**Files:**
- Modify: `tests/e2e/live-feed.spec.ts`

- [ ] **Step 1: Extend the existing 280px layout result**

Add `headerTimeValid` and `addressCopyAlignmentValid` fields. Reuse the existing computed-style and card-boundary visibility checks.

For the header, inspect `.event-trader-primary`, `.event-trader-name`, and `.event-time`; require all nodes to be visible and their vertical centers to differ by no more than 2px. Require `.event-action-line .event-time` to be absent.

For the address, inspect `.copyable-address-label`, `.copyable-address-value`, and `.copyable-address-button`; require the value and button to be visible, inside the card/viewport, horizontally ordered, separated by no more than 8px, and vertically centered within 2px. Do not use the label rectangle as the button-alignment reference.

- [ ] **Step 2: Run the feature E2E and verify GREEN**

Run:

```bash
corepack pnpm build
corepack pnpm exec playwright test tests/e2e/live-feed.spec.ts --grep "delivers live activity"
```

Expected: 1 test passes, including 280px header and address geometry.

- [ ] **Step 3: Run the complete verification set**

Run:

```bash
git diff --check
corepack pnpm typecheck
corepack pnpm vitest run tests/unit/EventCard.test.tsx tests/unit/CopyableAddress.test.tsx tests/unit/HistoryFeed.test.tsx
corepack pnpm build
corepack pnpm test:e2e
```

Expected: diff check, typecheck, focused unit tests, build, and all 10 E2E tests pass. If an established unrelated E2E diagnostic test times out once, rerun that exact test and report both results.

### Task 5: Update and Reload the Local Chrome Extension

**Files:**
- Build source: `.output/chrome-mv3`
- Installed unpacked target: `/Users/a77/Downloads/Fomo-Live-Feed-v0.1.0-chrome`

- [ ] **Step 1: Back up the installed unpacked extension**

Create a recoverable archive under `/private/tmp` before copying the new build.

- [ ] **Step 2: Copy and verify the production build**

Copy `.output/chrome-mv3/.` into the unpacked target and compare hashes for `manifest.json`, the active sidepanel JS chunk, and the active sidepanel CSS asset.

- [ ] **Step 3: Reload through Chrome extensions UI**

Open `chrome://extensions/`, reload extension ID `oobclbdbkmlckpfbcfhoakhogflaedbg`, refresh the Fomo tab, and inspect a live card. Confirm time appears beside the trader name and the copy icon aligns with the concrete address.

- [ ] **Step 4: Report verification honestly**

Report implemented files, test/build/E2E results, any unrelated baseline failures, the backup path, and whether live data supplied a card suitable for visual confirmation. Do not claim visual confirmation if no suitable live event was available.
