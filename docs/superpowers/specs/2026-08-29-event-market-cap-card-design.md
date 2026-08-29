# Event Market Cap Card Design

**Date:** 2026-08-29

## Goal

Enrich Side Panel activity cards with the market cap already attached to each
Fomo activity event, while removing misleading `Unavailable` placeholders for
fields that do not apply to opinion events.

## Scope

This design changes presentation only. It uses the existing optional
`TradeEventV1.usdAmount` and `TradeEventV1.marketCap` fields. It does not add a
quote API, authenticated requests, new host permissions, background refresh,
or a market-cap cache.

The following are explicitly out of scope:

- current or continuously refreshed market cap;
- original acquisition amount, entry market cap, position cost, or PnL;
- Fomo REST history or metric-adapter activation;
- changes to the event schema, IndexedDB schema, retention, or normalization;
- changes to translation behavior.

## Confirmed Data Semantics

- `usdAmount` is the USD notional of the activity event. On a sell event it is
  the amount sold in that event, not the trader's original purchase cost.
- `marketCap` is the market cap carried by the activity event. The UI presents
  it as event-associated market cap and never calls it current market cap.
- Both fields are optional. Missing values are omitted rather than replaced
  with zero or `Unavailable`.
- A real local sample of 100 stored rows had complete amount and market-cap
  coverage for 50 buys and 27 sells. All 23 thesis rows lacked both fields.
  This sample guides presentation but is not treated as a universal upstream
  guarantee.

## Card Layout

The identity header remains unchanged: avatar, trader name, handle, optional
followers, and relative time behavior continue to use existing components.

The activity line uses this order:

1. localized action label;
2. token image and symbol;
3. chain badge;
4. event USD amount, when present;
5. `MC:` followed by the formatted event market cap, when present;
6. relative event time.

Examples:

```text
卖出  $OTC  SOL  $1.84K  MC: $442K  刚刚
买入  $ROBUX  Robinhood  $500  MC: $1.25M  2分钟前
观点  $BOTS  Base  1分钟前
```

Opinion text and translation remain below the activity line. Contract address
and copy controls remain in the footer.

At narrow Side Panel widths, the line may wrap between the amount, market cap,
and time. Token identity and chain remain grouped so the chain badge is not
visually detached from the token.

## Missing-Data Rules

Presentation follows these closed rules:

| `usdAmount` | `marketCap` | Result |
| --- | --- | --- |
| present | present | Show amount and `MC: value`. |
| present | missing | Show amount only. |
| missing | present | Show `MC: value` only. |
| missing | missing | Show neither; retain action, token, chain, and time. |

The UI never renders:

- `Unavailable` for an absent event amount or market cap;
- an orphan `MC:` label;
- `$0` for a missing field;
- a synthesized market cap calculated from price or supply;
- a label implying the value is current, live, entry, or purchase market cap.

A real numeric zero remains valid upstream data and renders through the
existing compact USD formatter as `$0`.

## Localization

`MC:` is a compact financial abbreviation shared by English and Chinese UI,
so it does not require translated wording. If implemented through the message
catalog for consistency, both locales use the exact value `MC:`.

Relative-time localization is outside this change. Existing time behavior is
preserved.

## Components and Responsibilities

### Formatting

The existing `formatUsd` behavior remains the number-formatting source of
truth. A small optional-field presentation helper may return `undefined` for
missing values so React omits the element. It must not change `formatUsd`,
because other surfaces intentionally rely on its `Unavailable` fallback.

### Event Card

`src/popup/EventCard.tsx` owns the conditional rendering of amount and event
market cap. The Side Panel re-exports this card, so no duplicate card
implementation is introduced.

### Styling

`entrypoints/sidepanel/sidepanel.css` adds a market-cap style aligned with the
amount and adjusts wrapping only where necessary. The design must remain
readable at the existing 280 px E2E viewport.

## Accessibility

- Amount and market cap remain ordinary text and are available to assistive
  technology without tooltip-only information.
- Color is decorative; it does not carry the distinction between amount and
  market cap by itself.
- Existing card navigation, profile link behavior, token link behavior, and
  copy-address controls remain unchanged.

## Testing

Unit coverage must verify:

1. buy and sell cards show amount plus `MC:` when both fields exist;
2. opinion cards with neither field show no `Unavailable`, no `$0`, and no
   `MC:`;
3. each partial-data combination follows the missing-data table;
4. a real numeric zero renders as `$0`;
5. existing opinion translation and contract-address controls remain present;
6. English and Chinese card rendering use the intended compact label.

Browser-level verification must cover a production build at 280 px and a
normal Side Panel width, checking wrapping and absence of horizontal overflow.
Existing full-gate failures unrelated to this feature must be reported
separately rather than attributed to the card change.

## Acceptance Criteria

- Buy and sell cards display their existing event amount when present.
- Any card with an event market cap displays `MC:` and the compact USD value.
- Missing amounts and market caps leave no placeholder text.
- Opinion cards no longer show `Unavailable` merely because thesis events have
  no transaction amount.
- No new network request, permission, cache, schema migration, or persistent
  storage is introduced.
- Card interaction, translation, filtering, pagination, and address copying
  continue to work.
