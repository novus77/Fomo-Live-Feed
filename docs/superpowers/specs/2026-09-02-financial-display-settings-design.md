# Financial Display Settings Design

## Goal

Let users independently tune the font size and color of buy amounts, sell amounts, and market capitalization while preserving the feed's single-row trade summary and current density.

## Settings Model

Add a structured display-style section to the next local-settings schema:

```ts
interface FinancialTextStyle {
  fontSizePx: number;
  color: 'theme' | `#${string}`;
}

interface FinancialDisplaySettings {
  buyAmount: FinancialTextStyle;
  sellAmount: FinancialTextStyle;
  marketCap: FinancialTextStyle;
}
```

- Persist all three groups independently in `chrome.storage.local`.
- Migrate existing settings to defaults that reproduce the current UI.
- Validate font size as an integer from 11 through 18 pixels.
- Validate custom colors as six-digit hexadecimal values. `theme` keeps the semantic light/dark token.
- Preserve forward-compatible unknown fields in the existing settings parser.

## Settings UI

Add an `金额显示` / `Financial display` section containing three compact groups:

1. Buy amount
2. Sell amount
3. MC market cap

Each group contains:

- A live sample using that group's current size and color.
- Four presets: Small, Standard, Large, and Extra large.
- An 11–18 px slider for exact selection.
- Theme-safe preset swatches plus a native custom color picker.
- An independent reset action.

The section also provides one `Reset all` action. Changes apply to the feed immediately and persist asynchronously through the existing preferences boundary.

## Feed Application

- Buy amount settings affect `.event-card-buy .event-amount` only.
- Sell amount settings affect `.event-card-sell .event-amount` only.
- Market-cap settings affect `.event-market-cap` for every event type.
- Expose the selected values as scoped CSS custom properties on the side-panel root rather than generating stylesheet text.
- Keep the trade summary on one line. Financial groups remain non-wrapping, and constrained content ellipsizes instead of increasing card height.
- Transfer, withdraw, token, chain, thesis, and contract-address typography remain unchanged.

## Accessibility and Error Handling

- Every control has a localized label that includes its target metric.
- Keyboard users can operate presets, range inputs, color inputs, and reset actions.
- Show a contrast warning when a custom color is difficult to read on the active theme, without silently changing the user's selected color.
- Failed persistence keeps the last confirmed settings and surfaces the existing compact settings error state.

## Verification

Test schema migration, validation boundaries, independent updates, reset behavior, persistence, live CSS variables, action scoping, theme defaults, contrast warnings, keyboard access, narrow widths, and unchanged card-height density. Run the complete unit, build, and Playwright suites before release.
