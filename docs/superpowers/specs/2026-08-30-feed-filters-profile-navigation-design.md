# Feed Filters, Robinhood Label, and Profile Navigation

## Goal

Add a compact Side Panel filter popover without reducing feed density, abbreviate the Robinhood chain badge, and make trader-name navigation open the verified Fomo web profile route.

## Scope

1. Change the Robinhood presentation label from `Robinhood` to lowercase `rh`.
2. Add a funnel-button filter popover to the Side Panel header.
3. Support action visibility toggles for buy, sell, and thesis events.
4. Support an event market-cap range expressed in thousands of dollars (`K`).
5. Navigate valid trader handles to `https://fomo.family/profile/{handle}`.
6. Compact the existing support button to an icon-only heart button.

Purchase-amount filtering is explicitly excluded.

## Header Controls

The Side Panel header keeps one right-aligned control group in this order:

1. Filter.
2. Refresh.
3. Settings.
4. Support/tip.

All four controls use the same compact square footprint. Filter, refresh, and settings are icon-only. Support becomes an icon-only heart button; its localized accessible name and `title` continue to communicate the support/tip purpose.

The filter trigger uses a funnel icon. When filters differ from their defaults, a small count badge shows the number of active filter groups:

- Action selection counts as one active group when any of buy, sell, or thesis is disabled.
- Market-cap range counts as one active group when either endpoint is present.

The filter button exposes `aria-expanded` and `aria-haspopup="dialog"`. The popover closes on Escape and outside click, returning focus to the trigger on Escape.

## Filter Popover

The popover appears below the header control group and does not reserve feed height while closed.

### Action Row

The first row contains three toggle buttons:

- Buy.
- Sell.
- Thesis.

Each button displays a selected/check state and exposes `aria-pressed`.

All three are selected by default. They are independent and may all be disabled. If all three are disabled, buy, sell, and thesis events are hidden.

Withdraw and transfer events are not controlled by these three buttons and remain visible. They are still subject to the market-cap range when that range is active.

### Market-Cap Range Row

The second row contains two numeric inputs:

`[ minimum K ] to [ maximum K ]`

The visible suffix for each input is `K`. Input values are non-negative decimal numbers and represent thousands of US dollars. For example, `200` maps to `$200,000`.

Range behavior:

- Both endpoints: inclusive range, `minimum <= marketCap <= maximum`.
- Minimum only: `marketCap >= minimum`.
- Maximum only: `marketCap <= maximum`.
- Both empty: no market-cap filtering.
- A non-finite, negative, or otherwise invalid entry is invalid input.
- Events without a finite `marketCap` are hidden whenever either endpoint is active.

The inputs update local draft text immediately. A valid draft applies immediately. If both parsed endpoints exist and minimum exceeds maximum, the popover displays a localized inline error and keeps the last valid applied range. Correcting or clearing the draft applies the newly valid range.

No Apply button is added.

## Filter Model and Data Flow

The Side Panel filter model is extended with:

- A selected-action set for `buy`, `sell`, and `thesis`.
- Optional minimum market cap in US dollars.
- Optional maximum market cap in US dollars.

The filter UI owns only draft text and validation display. The applied normalized numeric range lives in the existing `SidePanelApp` filter state and is passed to `useEventFeed`.

Action and market-cap predicates are popup-side post-filters because the event repository has no suitable amount/action indexes. `loadEventPages` must continue scanning bounded pages when a whole page is removed by these filters, using its existing scan limit and cursor progression.

The existing popup-only legacy filter toolbar may continue supporting its current controls. The Side Panel receives a focused header filter component rather than mounting the full search/chain/trader/token toolbar.

Filter state is session-local and resets when the Side Panel is recreated. No settings schema migration or new persistence is introduced.

## Empty and Error States

- A valid filter yielding no events uses the existing empty-feed presentation.
- An invalid range displays an inline range error while retaining results from the last valid range.
- Repository/query errors continue to use the existing feed error and retry behavior.
- The reset action in the filter popover restores all three action buttons and clears both range endpoints.

## Robinhood Label

`CHAIN_PRESENTATION.robinhood.label` becomes `rh`. The underlying chain key remains `robinhood`; only presentation changes. This applies consistently anywhere the shared chain presentation catalog is used.

## Trader Profile Navigation

`buildFomoProfileUrl` changes its fixed path from `/user/` to `/profile/` while preserving:

- The fixed HTTPS `https://fomo.family` origin.
- Conservative handle validation.
- URL encoding.
- Null return for invalid handles.

The complete trader identity link may remain clickable, but clicking the displayed username must resolve to `https://fomo.family/profile/{handle}`. No raw URL from event data is trusted.

## Localization and Accessibility

Add localized English and Chinese strings for:

- Filter dialog and trigger.
- Action-filter label.
- Market-cap range label and endpoint labels/placeholders.
- Invalid-range message.
- Reset filters.

The visible `K` suffix and lowercase `rh` chain abbreviation remain invariant presentation tokens.

Every icon-only header button keeps a localized `aria-label` and `title`. Toggle states use `aria-pressed`; numeric inputs have explicit accessible labels. Keyboard focus remains inside normal document order, Escape closes the popover, and focus-visible styling is provided in both themes.

## Testing

Unit tests cover:

- Robinhood renders `rh` and keeps its chain icon/color.
- Default action selection passes all events.
- Buy/sell/thesis toggles independently remove only their event type.
- Withdraw/transfer remain visible regardless of action-toggle state.
- Inclusive two-sided market-cap ranges.
- Minimum-only and maximum-only ranges.
- Missing/non-finite market caps are removed when a range is active.
- Draft K values normalize to USD values.
- Invalid and reversed ranges retain the last valid applied range and show an error.
- Active group count is 0–2 under the defined counting rules.
- Filter popover keyboard/outside-click/reset behavior.
- Support button is icon-only with an accessible label/title.
- Valid profile URLs use `/profile/{handle}` and invalid handles remain non-navigable.

Integration tests cover bounded page continuation when action/range post-filters remove a complete page.

E2E covers:

- Header control order: filter, refresh, settings, support.
- All four controls fit without horizontal overflow at 280px.
- Opening the funnel popover, toggling action states, and applying one-sided/two-sided market-cap ranges updates visible cards.
- Invalid reversed ranges show an error and preserve the last valid results.
- Robinhood cards display `rh`.
- Trader identity link points to the fixed `/profile/` route.

## Non-Goals

- No purchase-amount filter.
- No new event fields, ingestion behavior, network requests, permissions, authentication, cache, database index, or settings migration.
- No automatic market-cap lookup for events that do not carry event market cap.
- No change to token navigation, copy behavior, translation behavior, card financial formatting, or refresh/recovery semantics.
