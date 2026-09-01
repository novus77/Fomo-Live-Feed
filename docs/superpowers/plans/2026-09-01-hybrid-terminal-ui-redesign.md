# Hybrid Terminal UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the complete Side Panel presentation as a compact professional trading terminal with semantic event borders, approved chain icons, polished utility views, and accessible state feedback without reducing feed density.

**Architecture:** Keep all event ingestion, persistence, filtering, navigation, translation, and notification contracts unchanged. Add a small presentation layer for semantic event styling, packaged chain artwork, compact feed states, and reusable control classes; then migrate the existing Side Panel composition and CSS onto those primitives. Lock density and motion behavior with focused component tests plus a real-extension Playwright viewport assertion.

**Tech Stack:** React 19, TypeScript 5.9, WXT 0.21, CSS custom properties, Vitest, Testing Library, Playwright

---

## File map

- Create `public/chains/*.svg`: packaged copies of the six approved chain icons.
- Create `src/sidepanel/ChainIcon.tsx`: the single mapping from `ChainKey` to packaged SVG path and accessible image markup.
- Create `src/sidepanel/event-presentation.ts`: semantic event modifier names shared by the card and tests.
- Create `src/sidepanel/FeedState.tsx`: compact skeleton, empty, and error state primitives.
- Modify `src/sidepanel/chain-presentation.tsx`: keep labels/colors but remove the legacy inline SVG artwork.
- Modify `src/sidepanel/ChainBadge.tsx`: render the approved `ChainIcon` before its compact label.
- Modify `src/sidepanel/ChainVisibilityFilter.tsx`: render the same icon before each full filter label.
- Modify `src/popup/EventCard.tsx`: add stable event/action data attributes and presentation classes without changing behavior.
- Modify `src/popup/HistoryFeed.tsx`: replace text-only loading/empty/error output with compact `FeedState` primitives.
- Modify `src/sidepanel/SidePanelApp.tsx`: add stable UI-region hooks and maintain one compact header row.
- Modify `src/sidepanel/FeedFilterPopover.tsx`: add semantic action classes and focus-safe dialog animation hooks.
- Modify `src/popup/SettingsPanel.tsx`: expose compact setting-row hooks while retaining all persistence callbacks.
- Modify `src/sidepanel/SupportPanel.tsx`: expose compact section hooks without altering wallet or Telegram behavior.
- Rewrite `entrypoints/sidepanel/sidepanel.css`: centralize design tokens, compact layout, semantic event borders, utility surfaces, state feedback, and reduced-motion behavior.
- Modify focused unit tests in `tests/unit/` and the real-extension scenario in `tests/e2e/live-feed.spec.ts`.
- Modify `docs/manual-testing.zh-CN.md`: add the visual-density and interaction verification matrix.

### Task 1: Package and render the approved chain icons

**Files:**
- Create: `public/chains/base.svg`
- Create: `public/chains/bsc.svg`
- Create: `public/chains/ethereum.svg`
- Create: `public/chains/robinhood.svg`
- Create: `public/chains/solana.svg`
- Create: `public/chains/xlayer.svg`
- Create: `src/sidepanel/ChainIcon.tsx`
- Modify: `src/sidepanel/chain-presentation.tsx`
- Modify: `src/sidepanel/ChainBadge.tsx`
- Modify: `src/sidepanel/ChainVisibilityFilter.tsx`
- Modify: `tests/unit/ChainBadge.test.tsx`
- Modify: `tests/unit/ChainVisibilityFilter.test.tsx`

- [ ] **Step 1: Write failing chain artwork tests**

Update `tests/unit/ChainBadge.test.tsx` so supported chains require a local image and unknown remains a text-safe fallback:

```tsx
it.each([
  ['bsc', '/chains/bsc.svg'],
  ['solana', '/chains/solana.svg'],
  ['robinhood', '/chains/robinhood.svg'],
  ['base', '/chains/base.svg'],
  ['ethereum', '/chains/ethereum.svg'],
  ['x-layer', '/chains/xlayer.svg'],
] as const)('renders approved local artwork for %s', (chain, src) => {
  render(<ChainBadge chain={chain} />);

  const image = document.querySelector<HTMLImageElement>('.chain-icon');
  expect(image).toHaveAttribute('src', src);
  expect(image).toHaveAttribute('alt', '');
  expect(document.body.innerHTML).not.toMatch(/https?:\/\//);
});

it('does not request artwork for an unknown chain', () => {
  render(<ChainBadge chain="unknown" />);
  expect(document.querySelector('.chain-icon')).not.toBeInTheDocument();
  expect(screen.getByText('Unknown')).toBeVisible();
});
```

Add to `tests/unit/ChainVisibilityFilter.test.tsx`:

```tsx
it('shows the approved icon beside every selectable chain label', () => {
  const { container } = render(
    <ChainVisibilityFilter
      visibleChains={[...FILTERABLE_CHAINS]}
      onChange={vi.fn()}
    />,
  );

  expect(container.querySelectorAll('.feed-filter-chain .chain-icon')).toHaveLength(6);
  expect(screen.getByRole('button', { name: 'Robinhood' })).toHaveTextContent('Robinhood');
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
pnpm vitest run tests/unit/ChainBadge.test.tsx tests/unit/ChainVisibilityFilter.test.tsx
```

Expected: FAIL because `.chain-icon` and `/chains/*.svg` image paths are not rendered.

- [ ] **Step 3: Copy the approved SVG source assets into the extension public tree**

Copy, without raster conversion or optimization that changes their shapes:

```text
图标/svg/base.svg       -> public/chains/base.svg
图标/svg/bsc.svg        -> public/chains/bsc.svg
图标/svg/ethereum.svg   -> public/chains/ethereum.svg
图标/svg/robinhood.svg  -> public/chains/robinhood.svg
图标/svg/solana.svg     -> public/chains/solana.svg
图标/svg/xlayer.svg     -> public/chains/xlayer.svg
```

- [ ] **Step 4: Add the chain icon mapping**

Create `src/sidepanel/ChainIcon.tsx`:

```tsx
import type { ChainKey } from '../domain/activity';

const CHAIN_ICON_PATHS = {
  bsc: '/chains/bsc.svg',
  solana: '/chains/solana.svg',
  robinhood: '/chains/robinhood.svg',
  base: '/chains/base.svg',
  ethereum: '/chains/ethereum.svg',
  'x-layer': '/chains/xlayer.svg',
} satisfies Partial<Record<ChainKey, string>>;

export function ChainIcon(props: { chain: ChainKey; className?: string }) {
  const src = CHAIN_ICON_PATHS[props.chain];

  if (src === undefined) return null;

  return (
    <img
      className={`chain-icon${props.className === undefined ? '' : ` ${props.className}`}`}
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
```

Remove the `ReactNode icon` member and inline SVG factory from `src/sidepanel/chain-presentation.tsx`; retain the existing labels, color tokens, and exact `rh` abbreviation.

- [ ] **Step 5: Render one icon component in both product contexts**

In `src/sidepanel/ChainBadge.tsx`, replace the legacy `presentation.icon` with:

```tsx
<ChainIcon chain={chain} className="chain-icon-feed" />
```

In each `src/sidepanel/ChainVisibilityFilter.tsx` button, insert before the label:

```tsx
<ChainIcon chain={chain} className="chain-icon-filter" />
```

Keep the check mark as a separate fixed-width element so selection does not move the icon or label.

- [ ] **Step 6: Run tests and verify packaged output**

Run:

```bash
pnpm vitest run tests/unit/ChainBadge.test.tsx tests/unit/ChainVisibilityFilter.test.tsx
pnpm build
```

Expected: both test files PASS; build succeeds; `.output/chrome-mv3/chains/` contains all six SVG files.

- [ ] **Step 7: Commit the asset integration**

```bash
git add public/chains src/sidepanel/ChainIcon.tsx src/sidepanel/chain-presentation.tsx src/sidepanel/ChainBadge.tsx src/sidepanel/ChainVisibilityFilter.tsx tests/unit/ChainBadge.test.tsx tests/unit/ChainVisibilityFilter.test.tsx
git commit -m "feat: add approved chain icons"
```

### Task 2: Add semantic event presentation to compact feed cards

**Files:**
- Create: `src/sidepanel/event-presentation.ts`
- Create: `tests/unit/event-presentation.test.ts`
- Modify: `src/popup/EventCard.tsx`
- Modify: `tests/unit/EventCard.test.tsx`
- Modify: `entrypoints/sidepanel/sidepanel.css`

- [ ] **Step 1: Write failing semantic class tests**

Create `tests/unit/event-presentation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { eventPresentationClass } from '../../src/sidepanel/event-presentation';

describe('eventPresentationClass', () => {
  it.each([
    ['buy', 'event-card-buy'],
    ['sell', 'event-card-sell'],
    ['thesis', 'event-card-thesis'],
    ['transfer', 'event-card-transfer'],
    ['withdraw', 'event-card-withdraw'],
  ] as const)('maps %s to %s', (action, expected) => {
    expect(eventPresentationClass(action)).toBe(expected);
  });
});
```

Add to `tests/unit/EventCard.test.tsx`:

```tsx
it.each([
  ['buy', 'event-card-buy'],
  ['sell', 'event-card-sell'],
  ['thesis', 'event-card-thesis'],
  ['transfer', 'event-card-transfer'],
  ['withdraw', 'event-card-withdraw'],
] as const)('marks %s cards with a semantic presentation class', (action, expected) => {
  const { container } = renderCard(makeEvent({ action }));
  const card = container.querySelector('article');

  expect(card).toHaveClass('event-card', expected);
  expect(card).toHaveAttribute('data-event-action', action);
});
```

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
pnpm vitest run tests/unit/event-presentation.test.ts tests/unit/EventCard.test.tsx
```

Expected: FAIL because `eventPresentationClass` and the modifier classes do not exist.

- [ ] **Step 3: Implement the event class mapping**

Create `src/sidepanel/event-presentation.ts`:

```ts
import type { ActivityAction } from '../domain/activity';

const EVENT_PRESENTATION_CLASS: Record<ActivityAction, string> = {
  buy: 'event-card-buy',
  sell: 'event-card-sell',
  thesis: 'event-card-thesis',
  transfer: 'event-card-transfer',
  withdraw: 'event-card-withdraw',
};

export const eventPresentationClass = (action: ActivityAction): string =>
  EVENT_PRESENTATION_CLASS[action];
```

- [ ] **Step 4: Attach stable semantic hooks without changing card content**

In `src/popup/EventCard.tsx`, build the class name before rendering:

```tsx
const cardClassName = [
  'event-card',
  eventPresentationClass(event.action),
  event.readAt === undefined ? 'event-card-unread' : '',
].filter(Boolean).join(' ');
```

Then render:

```tsx
<article
  className={cardClassName}
  data-event-id={event.id}
  data-event-action={event.action}
>
```

Keep time beside the name, CA copy alignment, token navigation boundary, optional amount, optional `MC:`, thesis translation, and profile navigation markup unchanged.

- [ ] **Step 5: Add event tokens and compact card rules**

At the start of `entrypoints/sidepanel/sidepanel.css`, define semantic tokens on `.sidepanel-root`:

```css
.sidepanel-root {
  --ui-canvas: #090d13;
  --ui-raised: #0d131c;
  --ui-control: #121a25;
  --ui-text: #f3f7ff;
  --ui-text-muted: #8997aa;
  --ui-rule: #202b39;
  --event-buy: #31d399;
  --event-sell: #f16d79;
  --event-thesis: #7ea7ff;
  --event-transfer: #e0a84b;
  --event-withdraw: #8997aa;
}
```

Style every card through one custom property:

```css
.event-card {
  --event-accent: var(--event-withdraw);
  margin: 4px 6px;
  padding: 8px 9px;
  border: 1px solid color-mix(in srgb, var(--event-accent) 32%, transparent);
  border-left-width: 2px;
  border-left-color: var(--event-accent);
  border-radius: 7px;
  background: var(--ui-raised);
}

.event-card-buy { --event-accent: var(--event-buy); }
.event-card-sell { --event-accent: var(--event-sell); }
.event-card-thesis { --event-accent: var(--event-thesis); }
.event-card-transfer { --event-accent: var(--event-transfer); }
.event-card-withdraw { --event-accent: var(--event-withdraw); }

.event-financials,
.event-market-cap,
.event-time,
.copyable-address-value {
  font-variant-numeric: tabular-nums;
}
```

Remove the old purple unread left border so it cannot override the event accent. Preserve or reduce every existing vertical gap; do not add a new card row.

- [ ] **Step 6: Run card and type tests**

Run:

```bash
pnpm vitest run tests/unit/event-presentation.test.ts tests/unit/EventCard.test.tsx tests/unit/CopyableAddress.test.tsx tests/unit/TranslatedOpinion.test.tsx
pnpm typecheck
```

Expected: all tests PASS and TypeScript reports no errors.

- [ ] **Step 7: Commit semantic cards**

```bash
git add src/sidepanel/event-presentation.ts src/popup/EventCard.tsx entrypoints/sidepanel/sidepanel.css tests/unit/event-presentation.test.ts tests/unit/EventCard.test.tsx
git commit -m "feat: style feed cards by event type"
```

### Task 3: Rebuild the compact header, toolbar, and filter popover

**Files:**
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `src/sidepanel/FeedFilterPopover.tsx`
- Modify: `src/sidepanel/RefreshButton.tsx`
- Modify: `tests/unit/SidePanelApp.test.tsx`
- Modify: `tests/unit/FeedFilterPopover.test.tsx`
- Modify: `tests/unit/RefreshButton.test.tsx`
- Modify: `entrypoints/sidepanel/sidepanel.css`

- [ ] **Step 1: Write failing composition and semantic-action tests**

Add to `tests/unit/SidePanelApp.test.tsx` after the connected render helper is available:

```tsx
it('keeps title, connection state, and four utility controls in one compact header', async () => {
  const harness = createHarness({
    ok: true,
    connected: true,
    authenticated: true,
    hasFomoTab: true,
  });
  const { container } = render(<SidePanelApp deps={harness.deps} />);

  await waitFor(() => expect(connectionStatus()).toHaveTextContent('Connected'));
  const header = container.querySelector('.sidepanel-header');
  expect(header).toContainElement(screen.getByRole('heading', { name: 'Fomo Live Feed' }));
  expect(header).toContainElement(connectionStatus());
  expect(within(header as HTMLElement).getAllByRole('button')).toHaveLength(4);
});
```

Add to `tests/unit/FeedFilterPopover.test.tsx`:

```tsx
it.each([
  ['Buy', 'feed-filter-action-buy'],
  ['Sell', 'feed-filter-action-sell'],
  ['Opinion', 'feed-filter-action-thesis'],
] as const)('adds the semantic %s action class', (name, className) => {
  renderPopover();
  expect(screen.getByRole('button', { name })).toHaveClass(className);
});
```

Retain the existing Escape focus-restoration assertion and extend it to assert `aria-expanded="false"` after close.

- [ ] **Step 2: Run tests and verify the new assertions fail**

Run:

```bash
pnpm vitest run tests/unit/SidePanelApp.test.tsx tests/unit/FeedFilterPopover.test.tsx tests/unit/RefreshButton.test.tsx
```

Expected: semantic action class assertions FAIL; existing behavior assertions continue to pass.

- [ ] **Step 3: Add stable region and control hooks**

In `src/sidepanel/SidePanelApp.tsx`:

- add `data-ui-region="header"` to the header;
- add `data-ui-region="toolbar"` to `.sidepanel-header-controls`;
- add the shared `compact-icon-button` class to settings and support buttons;
- keep button order exactly filter, refresh, settings, support;
- keep support icon-only and retain its localized `title` tooltip.

In `src/sidepanel/RefreshButton.tsx`, add `compact-icon-button` to the existing button class list and expose syncing state as `data-refreshing="true"` only while a refresh is active.

- [ ] **Step 4: Add semantic filter classes and stable dialog state**

In `src/sidepanel/FeedFilterPopover.tsx`, construct action classes as:

```tsx
className={`feed-filter-action feed-filter-action-${action}`}
```

Add `compact-icon-button` to the trigger, keep `role="dialog"`, outside-click close, Escape close, and focus restoration. Do not move the filter state or persistence logic into the popover.

- [ ] **Step 5: Implement compact toolbar and popover motion**

Add the shared control rules:

```css
.compact-icon-button {
  width: 31px;
  height: 31px;
  padding: 0;
  border: 1px solid var(--ui-rule);
  border-radius: 8px;
  background: var(--ui-control);
  color: var(--ui-text-muted);
  transition: color 140ms ease, background-color 140ms ease, border-color 140ms ease, transform 140ms cubic-bezier(.2,.8,.2,1);
}

.compact-icon-button:hover { color: var(--ui-text); }
.compact-icon-button:active { transform: scale(.94); }
.compact-icon-button:focus-visible { outline: 2px solid var(--event-thesis); outline-offset: 2px; }

.feed-filter-popover {
  animation: filter-popover-in 180ms cubic-bezier(.2,.8,.2,1) both;
  transform-origin: top right;
}

@keyframes filter-popover-in {
  from { opacity: 0; transform: translateY(-3px); }
  to { opacity: 1; transform: translateY(0); }
}
```

Use semantic selected colors for buy, sell, and opinion buttons. Keep the popover at `width: min(300px, calc(100vw - 24px))`, and ensure each range input retains `min-width: 0` so a 280 px panel cannot clip horizontally. Chain buttons remain two columns and use 16 px icons without exceeding the current 44 px hit height.

- [ ] **Step 6: Run toolbar/filter tests**

Run:

```bash
pnpm vitest run tests/unit/SidePanelApp.test.tsx tests/unit/FeedFilterPopover.test.tsx tests/unit/RefreshButton.test.tsx tests/unit/market-cap-range.test.ts tests/unit/chain-visibility.test.ts
```

Expected: all tests PASS, including Escape focus restoration, market-cap validation, and transfer/withdraw filter independence.

- [ ] **Step 7: Commit toolbar and filter work**

```bash
git add src/sidepanel/SidePanelApp.tsx src/sidepanel/FeedFilterPopover.tsx src/sidepanel/RefreshButton.tsx entrypoints/sidepanel/sidepanel.css tests/unit/SidePanelApp.test.tsx tests/unit/FeedFilterPopover.test.tsx tests/unit/RefreshButton.test.tsx
git commit -m "feat: redesign side panel toolbar and filters"
```

### Task 4: Redesign settings, support, and diagnostics as compact utility views

**Files:**
- Modify: `src/popup/SettingsPanel.tsx`
- Modify: `src/sidepanel/SupportPanel.tsx`
- Modify: `src/sidepanel/PipelineDiagnostics.tsx`
- Modify: `tests/unit/SettingsPanel.test.tsx`
- Modify: `tests/unit/SupportPanel.test.tsx`
- Modify: `tests/unit/PipelineDiagnostics.test.tsx`
- Modify: `entrypoints/sidepanel/sidepanel.css`

- [ ] **Step 1: Write failing compact-section tests**

Add to `tests/unit/SettingsPanel.test.tsx`:

```tsx
it('groups every preference into compact setting rows', () => {
  const { container } = renderPanel();
  expect(container.querySelectorAll('.settings-section')).toHaveLength(4);
  expect(container.querySelectorAll('.settings-toggle-row')).toHaveLength(2);
});
```

Add to `tests/unit/SupportPanel.test.tsx`:

```tsx
it('uses compact utility sections without changing support destinations', () => {
  const { container } = render(
    <SupportPanel copyText={vi.fn().mockResolvedValue(undefined)} openLink={vi.fn()} />,
  );
  expect(container.querySelector('.support-panel')).toHaveClass('utility-panel');
  expect(screen.getByText(BSC_SUPPORT_ADDRESS)).toBeVisible();
  expect(screen.getByText(SOLANA_SUPPORT_ADDRESS)).toBeVisible();
});
```

Add to `tests/unit/PipelineDiagnostics.test.tsx` an assertion that the root has both `pipeline-diagnostics` and `utility-diagnostics` classes.

- [ ] **Step 2: Run utility tests and verify they fail**

Run:

```bash
pnpm vitest run tests/unit/SettingsPanel.test.tsx tests/unit/SupportPanel.test.tsx tests/unit/PipelineDiagnostics.test.tsx
```

Expected: FAIL because the compact presentation hooks are absent.

- [ ] **Step 3: Add presentation hooks while preserving callbacks**

In `src/popup/SettingsPanel.tsx`:

- add `utility-panel` to the root;
- add `settings-section` to language, theme, translation, and notification sections;
- add `settings-toggle-row` to translation and buy-sound toggle labels;
- keep every input, `aria-label`, `disabled` state, and callback unchanged.

In `src/sidepanel/SupportPanel.tsx`, add `utility-panel` to the root and `utility-section` to address and group areas. Preserve both exact addresses, feedback timers, copy behavior, and Telegram URL.

In `src/sidepanel/PipelineDiagnostics.tsx`, add `utility-diagnostics` to the root only; retain the current health derivation and labels.

- [ ] **Step 4: Apply the compact section visual system**

Use one shared surface rather than nested large cards:

```css
.utility-panel,
.utility-diagnostics {
  margin: 8px;
  border: 1px solid var(--ui-rule);
  border-radius: 8px;
  background: var(--ui-raised);
}

.settings-section,
.utility-section {
  padding: 10px 11px;
  border-bottom: 1px solid var(--ui-rule);
}

.settings-section:last-child,
.utility-section:last-child { border-bottom: 0; }

.settings-toggle-row {
  min-height: 32px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}
```

Style switches with a fixed-width track and `transform: translateX(...)` thumb animation lasting 160 ms. Keep diagnostics values monospaced and map healthy/degraded/unavailable text to emerald/amber/muted colors without hiding the label.

- [ ] **Step 5: Run utility and persistence regression tests**

Run:

```bash
pnpm vitest run tests/unit/SettingsPanel.test.tsx tests/unit/SupportPanel.test.tsx tests/unit/PipelineDiagnostics.test.tsx tests/unit/local-preferences.test.ts tests/unit/buy-sound.test.ts
```

Expected: all tests PASS; sound remains globally enabled/disabled by the single existing setting.

- [ ] **Step 6: Commit utility surfaces**

```bash
git add src/popup/SettingsPanel.tsx src/sidepanel/SupportPanel.tsx src/sidepanel/PipelineDiagnostics.tsx entrypoints/sidepanel/sidepanel.css tests/unit/SettingsPanel.test.tsx tests/unit/SupportPanel.test.tsx tests/unit/PipelineDiagnostics.test.tsx
git commit -m "feat: polish side panel utility views"
```

### Task 5: Add compact loading, empty, and failure feedback

**Files:**
- Create: `src/sidepanel/FeedState.tsx`
- Create: `tests/unit/FeedState.test.tsx`
- Modify: `src/popup/HistoryFeed.tsx`
- Modify: `tests/unit/HistoryFeed.test.tsx`
- Modify: `entrypoints/sidepanel/sidepanel.css`

- [ ] **Step 1: Write failing state primitive tests**

Create `tests/unit/FeedState.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { FeedState, FeedSkeleton } from '../../src/sidepanel/FeedState';

describe('FeedState', () => {
  it('renders one compact recovery action', () => {
    const onAction = vi.fn();
    render(<FeedState tone="empty" message="No matching activity" actionLabel="Reset" onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('marks failures as alerts', () => {
    render(<FeedState tone="error" message="Refresh failed" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Refresh failed');
  });

  it('renders three fixed card-shaped skeletons', () => {
    const { container } = render(<FeedSkeleton rows={3} loadingLabel="Loading activity" />);
    expect(container.querySelectorAll('.feed-skeleton-card')).toHaveLength(3);
  });
});
```

Extend `tests/unit/HistoryFeed.test.tsx` to assert:

```tsx
expect(container.querySelectorAll('.feed-skeleton-card')).toHaveLength(3);
expect(screen.getByRole('alert')).toHaveClass('feed-state-error');
expect(screen.getByRole('button', { name: 'Select all chains' })).toBeVisible();
```

- [ ] **Step 2: Run state tests and verify they fail**

Run:

```bash
pnpm vitest run tests/unit/FeedState.test.tsx tests/unit/HistoryFeed.test.tsx
```

Expected: FAIL because the state primitives and skeleton markup do not exist.

- [ ] **Step 3: Implement compact state primitives**

Create `src/sidepanel/FeedState.tsx`:

```tsx
import type { ReactNode } from 'react';

export function FeedState(props: {
  tone: 'empty' | 'error' | 'info';
  message: string;
  icon?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
}) {
  const role = props.tone === 'error' ? 'alert' : 'status';
  return (
    <div className={`feed-state feed-state-${props.tone}`} role={role}>
      {props.icon !== undefined && <span className="feed-state-icon" aria-hidden="true">{props.icon}</span>}
      <span className="feed-state-message">{props.message}</span>
      {props.actionLabel !== undefined && props.onAction !== undefined && (
        <button type="button" className="feed-state-action" onClick={props.onAction}>
          {props.actionLabel}
        </button>
      )}
    </div>
  );
}

export function FeedSkeleton(props: { rows?: number; loadingLabel: string }) {
  const rows = props.rows ?? 3;
  return (
    <div className="feed-skeleton" aria-label={props.loadingLabel}>
      {Array.from({ length: rows }, (_, index) => (
        <div className="feed-skeleton-card" aria-hidden="true" key={index}>
          <span className="feed-skeleton-avatar" />
          <span className="feed-skeleton-line feed-skeleton-line-primary" />
          <span className="feed-skeleton-line feed-skeleton-line-secondary" />
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Migrate HistoryFeed state branches**

In `src/popup/HistoryFeed.tsx`:

- loading → `<FeedSkeleton rows={3} loadingLabel={translate('feed.loading')} />`;
- first-load error → error `FeedState` with existing retry callback;
- no chains → empty `FeedState` with existing select-all callback;
- connected empty → empty `FeedState` with no action;
- scan exceeded → info `FeedState` above the retained cards.

Do not replace existing cards during a background refresh or pagination request.

- [ ] **Step 5: Add fixed geometry and one-shot feedback styles**

```css
.feed-skeleton-card {
  height: 86px;
  margin: 4px 6px;
  border: 1px solid var(--ui-rule);
  border-radius: 7px;
  background: var(--ui-raised);
  animation: skeleton-once 650ms ease-out 1 both;
}

@keyframes skeleton-once {
  from { opacity: .52; }
  to { opacity: 1; }
}

.feed-state {
  margin: 10px 8px;
  min-height: 52px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--ui-rule);
  border-radius: 8px;
  color: var(--ui-text-muted);
}
```

Measure the current card’s rendered height before setting the skeleton constant; use that exact measured value if it differs from 86 px. The skeleton must match the production card rather than force the card to match the skeleton.

- [ ] **Step 6: Run state and feed regression tests**

Run:

```bash
pnpm vitest run tests/unit/FeedState.test.tsx tests/unit/HistoryFeed.test.tsx tests/unit/SidePanelApp.test.tsx
```

Expected: all tests PASS; old data remains visible for background refresh and pagination states.

- [ ] **Step 7: Commit feed states**

```bash
git add src/sidepanel/FeedState.tsx src/popup/HistoryFeed.tsx entrypoints/sidepanel/sidepanel.css tests/unit/FeedState.test.tsx tests/unit/HistoryFeed.test.tsx
git commit -m "feat: add compact feed feedback states"
```

### Task 6: Finish themes, motion, and accessibility contracts

**Files:**
- Create: `tests/unit/sidepanel-style-contract.test.ts`
- Modify: `entrypoints/sidepanel/sidepanel.css`
- Modify: `tests/unit/CopyableAddress.test.tsx`

- [ ] **Step 1: Write a failing CSS contract test**

Create `tests/unit/sidepanel-style-contract.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('entrypoints/sidepanel/sidepanel.css', 'utf8');

describe('side panel style contract', () => {
  it('defines both theme foundations and every event accent', () => {
    expect(css).toContain(".sidepanel-root[data-theme='light']");
    for (const token of ['--event-buy', '--event-sell', '--event-thesis', '--event-transfer', '--event-withdraw']) {
      expect(css).toContain(token);
    }
  });

  it('removes spatial motion for reduced-motion users', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(css).toContain('animation-duration: 0.01ms');
    expect(css).toContain('transform: none');
  });
});
```

Extend `tests/unit/CopyableAddress.test.tsx` so success and failure states retain the same button element and do not add a text node that changes its width.

- [ ] **Step 2: Run tests and verify the CSS contract fails**

Run:

```bash
pnpm vitest run tests/unit/sidepanel-style-contract.test.ts tests/unit/CopyableAddress.test.tsx
```

Expected: FAIL until final tokens and reduced-motion override are present.

- [ ] **Step 3: Complete the light theme token override**

Define the light theme only by overriding tokens:

```css
.sidepanel-root[data-theme='light'] {
  --ui-canvas: #f4f6f9;
  --ui-raised: #ffffff;
  --ui-control: #eef2f6;
  --ui-text: #121923;
  --ui-text-muted: #5d697a;
  --ui-rule: #d8dee7;
  --event-buy: #087f5b;
  --event-sell: #c92a3a;
  --event-thesis: #315fbd;
  --event-transfer: #946200;
  --event-withdraw: #5d697a;
}
```

Replace hard-coded old navy/purple colors in Side Panel-specific selectors with these tokens. Chain brand tokens may remain chain-specific.

- [ ] **Step 4: Add non-looping new-event and copy feedback hooks**

Use one animation for newly unread live cards and one color transition for copy feedback:

```css
.event-card-unread {
  animation: event-arrival 620ms cubic-bezier(.2,.8,.2,1) 1 both;
}

@keyframes event-arrival {
  from { opacity: 0; transform: translateY(5px); box-shadow: inset 2px 0 var(--event-accent); }
  to { opacity: 1; transform: translateY(0); box-shadow: inset 0 0 transparent; }
}
```

Do not add continuous pulse, glow, bounce, particles, marquee, or repeating skeleton shimmer.

- [ ] **Step 5: Add the reduced-motion override**

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    scroll-behavior: auto !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }

  .compact-icon-button:active,
  .feed-filter-popover,
  .event-card-unread {
    transform: none !important;
  }
}
```

- [ ] **Step 6: Run accessibility-oriented tests and typecheck**

Run:

```bash
pnpm vitest run tests/unit/sidepanel-style-contract.test.ts tests/unit/CopyableAddress.test.tsx tests/unit/ConnectionIndicator.test.tsx tests/unit/LocaleProvider.test.tsx
pnpm typecheck
```

Expected: all tests PASS and TypeScript reports no errors.

- [ ] **Step 7: Commit themes and motion**

```bash
git add entrypoints/sidepanel/sidepanel.css tests/unit/sidepanel-style-contract.test.ts tests/unit/CopyableAddress.test.tsx
git commit -m "feat: finalize accessible side panel motion"
```

### Task 7: Lock viewport density and narrow-panel behavior in Playwright

**Files:**
- Modify: `tests/e2e/live-feed.spec.ts`
- Modify: `docs/manual-testing.zh-CN.md`

- [ ] **Step 1: Add an exact E2E density assertion**

Add a helper below the existing `AttachedTarget` class in `tests/e2e/live-feed.spec.ts`:

```ts
const readFeedGeometry = async (panel: AttachedTarget) => {
  return panel.evaluate<{
    viewportHeight: number;
    cardHeights: number[];
    completeCards: number;
    horizontalOverflow: boolean;
  }>(`(() => {
      const cards = [...document.querySelectorAll('.event-card')];
      return {
        viewportHeight: window.innerHeight,
        cardHeights: cards.slice(0, 5).map((card) => card.getBoundingClientRect().height),
        completeCards: cards.filter((card) => card.getBoundingClientRect().bottom <= window.innerHeight).length,
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      };
    })()`);
};
```

In the existing multiple-event feed scenario, set the Side Panel target viewport to 320 × 720 through the attached target, require a defined geometry result, then assert:

```ts
await panel.send('Emulation.setDeviceMetricsOverride', {
  width: 320,
  height: 720,
  deviceScaleFactor: 1,
  mobile: false,
});
const geometry = await readFeedGeometry(panel);
if (geometry === undefined) throw new Error('feed geometry is unavailable');
expect(geometry.horizontalOverflow).toBe(false);
expect(geometry.cardHeights).toHaveLength(5);
expect(Math.max(...geometry.cardHeights)).toBeLessThanOrEqual(92);
expect(geometry.completeCards).toBeGreaterThanOrEqual(6);
```

Before implementation, record the current release’s actual maximum card height and complete-card count in the test comment. If the current release shows more than six complete cards or has a lower maximum height, use those stricter baseline numbers instead.

- [ ] **Step 2: Add real-extension utility interaction coverage**

In the same E2E scenario, use the existing `AttachedTarget` methods:

```ts
await panel.click('.sidepanel-filter-toggle');
await expect.poll(() => panel.exists('.feed-filter-popover')).toBe(true);
await panel.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
await panel.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
await expect.poll(() => panel.exists('.feed-filter-popover')).toBe(false);

await panel.click('[data-testid="settings-toggle"]');
await expect.poll(() => panel.exists('.settings-panel.utility-panel')).toBe(true);
await panel.click('.sidepanel-support-toggle');
await expect.poll(() => panel.exists('.support-panel.utility-panel')).toBe(true);
```

- [ ] **Step 3: Run build and the focused E2E scenario**

Run:

```bash
pnpm build
pnpm playwright test tests/e2e/live-feed.spec.ts
```

Expected: build succeeds; E2E suite PASS; 320 px width has no horizontal overflow and meets or beats the recorded density baseline.

- [ ] **Step 4: Update the manual verification matrix**

Add a Chinese section to `docs/manual-testing.zh-CN.md` covering these exact checks:

```markdown
## 混合终端 UI 回归

- 在 280 px、320 px 和 400 px 宽度检查：页面不得出现横向滚动。
- 对相同 6 条普通交易数据，改版后完整可见卡片数不得少于改版前基线。
- 分别检查买入、卖出、观点、转入、转出边框；文字标签必须始终存在。
- 检查 BSC、Solana、Base、Robinhood、Ethereum、X Layer 在信息流与筛选器中的 SVG 图标。
- 检查深色与浅色主题，以及系统“减少动态效果”开启后的交互反馈。
- 打开筛选、设置、支持，再按 Escape 或切换工具按钮；界面不得重叠或横向裁切。
- 刷新已有数据时旧卡片保持可见；失败时显示紧凑重试提示。
```

- [ ] **Step 5: Commit density coverage**

```bash
git add tests/e2e/live-feed.spec.ts docs/manual-testing.zh-CN.md
git commit -m "test: lock side panel visual density"
```

### Task 8: Full regression, production build, and review checkpoint

**Files:**
- Verify only; modify a source file only when a failing check identifies a concrete regression.

- [ ] **Step 1: Run formatting and type checks**

Run:

```bash
git diff --check
pnpm typecheck
```

Expected: no whitespace errors and no TypeScript errors.

- [ ] **Step 2: Run the complete unit and integration suite**

Run:

```bash
pnpm test
```

Expected: all Vitest suites PASS, including filtering, persistence, translation, navigation, buy sound, connection state, event rendering, and the new presentation contracts.

- [ ] **Step 3: Build and run the real-extension suite**

Run:

```bash
pnpm build
pnpm test:e2e
```

Expected: WXT production build succeeds and all Playwright scenarios PASS.

- [ ] **Step 4: Inspect the production artifact**

Run:

```bash
find .output/chrome-mv3/chains -maxdepth 1 -type f -name '*.svg' | sort
```

Expected: exactly these six paths are printed:

```text
.output/chrome-mv3/chains/base.svg
.output/chrome-mv3/chains/bsc.svg
.output/chrome-mv3/chains/ethereum.svg
.output/chrome-mv3/chains/robinhood.svg
.output/chrome-mv3/chains/solana.svg
.output/chrome-mv3/chains/xlayer.svg
```

- [ ] **Step 5: Review the final diff against the approved boundaries**

Run:

```bash
git diff HEAD~7 -- src entrypoints public tests docs/manual-testing.zh-CN.md
git status --short
```

Expected: the feature diff is limited to presentation assets, Side Panel/popup presentation components, CSS, tests, and the manual test document. There are no changes to event ingestion, storage schemas, message protocols, navigation contracts, translation engines, or notification behavior. Pre-existing unrelated working-tree files remain untouched and unstaged.

- [ ] **Step 6: Create the final implementation checkpoint**

If verification identifies a regression, return to the task that owns the failing component, add a focused regression test there, apply the minimum correction, rerun that task's commands, and commit the exact files listed by `git diff --name-only` with message `fix: resolve side panel ui regression`. If no correction is required, do not create an empty commit. Stop for visual review and local extension reload before any merge, push, version bump, package publication, or GitHub release.
