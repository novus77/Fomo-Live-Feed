# Token and Chain Inline Layout Design

## Goal

Restore compact token-row spacing and place the event chain immediately after the token symbol without increasing card height.

## Root Cause

`.event-token-symbol` currently uses `flex: 1`. Interactive symbols render as buttons, so the button expands across the available token column and its centered text appears detached from the token image. The expanded symbol also pushes the chain badge to the far edge.

## Layout Contract

- Preserve the row order: action, token identity, financial values.
- Keep the token image, symbol, and chain badge in one inline identity group.
- Size the symbol from its content and allow it to shrink only when horizontal space is constrained.
- Left-align interactive symbol text.
- Keep a four-to-five-pixel gap between image, symbol, and chain badge.
- Preserve the current single-row height and ellipsize long symbols before displacing financial values.
- Do not integrate the proposed BSC or Robinhood replacement vectors in this change.

## Validation

Add a CSS contract test for the non-growing, left-aligned token symbol. Run EventCard unit tests, the side-panel density browser scenario, and the production build.
