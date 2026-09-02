# Financial Display Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users independently customize the font size and color of buy amounts, sell amounts, and market-cap values while preserving the current compact feed density.

**Architecture:** Upgrade local settings from V4 to V5 with a structured `financialDisplay` object. Keep each financial role independent, expose one reusable settings editor, and apply persisted values through CSS custom properties on the side-panel root so cards remain presentational and lightweight.

**Tech Stack:** React 19, TypeScript, Zod, chrome.storage.local, CSS custom properties, Vitest, React Testing Library, Playwright

---

### Task 1: Define and validate the V5 settings contract

**Files:**
- Modify: `src/domain/settings.ts`
- Modify: `tests/unit/local-preferences.test.ts`

- [ ] **Step 1: Write failing schema/default tests**

Add assertions that the defaults contain three independent roles and that invalid sizes and colors are rejected:

```ts
expect(DEFAULT_SETTINGS.financialDisplay).toEqual({
  buyAmount: { fontSizePx: 13, color: 'theme' },
  sellAmount: { fontSizePx: 13, color: 'theme' },
  marketCap: { fontSizePx: 13, color: 'theme' },
});

expect(localSettingsV5Schema.safeParse({
  ...DEFAULT_SETTINGS,
  financialDisplay: {
    ...DEFAULT_SETTINGS.financialDisplay,
    buyAmount: { fontSizePx: 19, color: '#18d79c' },
  },
}).success).toBe(false);
```

Also reject malformed colors such as `red`, `#fff`, CSS functions, and whitespace-padded values. Accept only the sentinel `theme` or a six-digit hexadecimal color.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/local-preferences.test.ts
```

Expected: FAIL because `LocalSettingsV5`, `localSettingsV5Schema`, and `financialDisplay` do not exist.

- [ ] **Step 3: Add the V5 domain types and schema**

Add explicit reusable types and bounds:

```ts
export const FINANCIAL_FONT_SIZE_MIN = 11;
export const FINANCIAL_FONT_SIZE_MAX = 18;
export type FinancialTextColor = 'theme' | `#${string}`;

export interface FinancialTextStyle {
  fontSizePx: number;
  color: FinancialTextColor;
}

export interface FinancialDisplaySettings {
  buyAmount: FinancialTextStyle;
  sellAmount: FinancialTextStyle;
  marketCap: FinancialTextStyle;
}

export interface LocalSettingsV5 extends Omit<LocalSettingsV4, 'schemaVersion'> {
  schemaVersion: 5;
  financialDisplay: FinancialDisplaySettings;
}
```

Use an integer Zod range of 11–18 and `/^#[0-9a-fA-F]{6}$/` for custom colors. Export `DEFAULT_FINANCIAL_DISPLAY` and make `DEFAULT_SETTINGS` a `LocalSettingsV5`. Preserve V1–V4 schemas for migration reads.

Update `LocalSettingsUpdate` so each top-level role may be changed independently:

```ts
financialDisplay?: Partial<{
  [K in keyof FinancialDisplaySettings]: Partial<FinancialDisplaySettings[K]>;
}>;
```

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/local-preferences.test.ts
/usr/local/bin/node node_modules/typescript/bin/tsc --noEmit
```

Expected: focused tests and typecheck PASS.

Commit:

```bash
git add src/domain/settings.ts tests/unit/local-preferences.test.ts
git commit -m "feat: define financial display settings"
```

### Task 2: Migrate, merge, and persist V5 settings safely

**Files:**
- Modify: `src/storage/local-preferences.ts`
- Modify: `tests/unit/local-preferences.test.ts`

- [ ] **Step 1: Write failing migration and merge tests**

Cover all of these boundaries:

1. A valid `settings.v5` record loads unchanged.
2. V4 migrates once to V5, preserving every existing preference.
3. V3/V2/V1 continue to migrate directly to the V5 result.
4. Corrupt V5 falls back to valid V4 before older keys.
5. Updating `buyAmount.color` does not change its size or either sibling role.
6. Concurrent updates to different roles serialize without lost writes.

```ts
const first = preferences.updateSettings({
  financialDisplay: { buyAmount: { color: '#18D79C' } },
});
const second = preferences.updateSettings({
  financialDisplay: { marketCap: { fontSizePx: 15 } },
});

await Promise.all([first, second]);
expect(await preferences.getSettings()).toMatchObject({
  financialDisplay: {
    buyAmount: { fontSizePx: 13, color: '#18D79C' },
    sellAmount: { fontSizePx: 13, color: 'theme' },
    marketCap: { fontSizePx: 15, color: 'theme' },
  },
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/local-preferences.test.ts
```

Expected: migration/storage-key/partial-merge tests FAIL against V4 storage.

- [ ] **Step 3: Implement the V5 storage adapter**

Add `SETTINGS_STORAGE_KEY = 'settings.v5'` and keep `settings.v4` as a read-only legacy key. Parse V5 first, then migrate V4 and older records. Do not delete legacy records.

Deep-merge the role styles explicitly rather than spreading only the top level:

```ts
const nextFinancialDisplay = {
  buyAmount: {
    ...current.financialDisplay.buyAmount,
    ...update.financialDisplay?.buyAmount,
  },
  sellAmount: {
    ...current.financialDisplay.sellAmount,
    ...update.financialDisplay?.sellAmount,
  },
  marketCap: {
    ...current.financialDisplay.marketCap,
    ...update.financialDisplay?.marketCap,
  },
};
```

Normalize accepted hex colors to uppercase when converting parsed data, so equality and rendering remain deterministic. Keep the existing serialized update queue.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/local-preferences.test.ts tests/unit/LocaleProvider.test.tsx
```

Expected: migration, fallback, concurrent update, and locale regression tests PASS.

Commit:

```bash
git add src/storage/local-preferences.ts tests/unit/local-preferences.test.ts tests/unit/LocaleProvider.test.tsx
git commit -m "feat: persist financial display settings"
```

### Task 3: Build the three-role financial appearance editor

**Files:**
- Create: `src/popup/FinancialDisplaySettings.tsx`
- Create: `tests/unit/FinancialDisplaySettings.test.tsx`
- Modify: `src/i18n/catalog.ts`
- Modify: `tests/unit/i18n-catalog.test.ts`
- Modify: `entrypoints/sidepanel/sidepanel.css`

- [ ] **Step 1: Write failing component tests**

Render all three groups and assert they operate independently:

```tsx
render(
  <FinancialDisplaySettings
    value={DEFAULT_SETTINGS.financialDisplay}
    onChange={onChange}
  />,
);

expect(screen.getByRole('group', { name: 'Buy amount' })).toBeInTheDocument();
expect(screen.getByRole('group', { name: 'Sell amount' })).toBeInTheDocument();
expect(screen.getByRole('group', { name: 'Market cap' })).toBeInTheDocument();

fireEvent.change(screen.getByRole('slider', { name: 'Buy amount font size' }), {
  target: { value: '16' },
});
expect(onChange).toHaveBeenLastCalledWith({
  buyAmount: { fontSizePx: 16 },
});
```

Also test preset buttons, theme-color reset, custom color input, per-role reset, reset-all, sample text, and the low-contrast warning. A warning must not block saving.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/FinancialDisplaySettings.test.tsx
```

Expected: FAIL because the component does not exist.

- [ ] **Step 3: Add localized settings copy**

Add English and Simplified Chinese keys for the section title, three roles, font size, theme color, custom color, presets, resets, preview, and contrast warning. Keep visible Chinese labels aligned with the approved mockup: `买入金额`, `卖出金额`, `市值`, `字号`, `主题色`, `自定义颜色`, and `恢复默认`.

- [ ] **Step 4: Implement one reusable role editor**

Use a small internal `FinancialRoleEditor` for all roles. Its controls are:

- preset buttons mapping to 11, 13, 16, and 18 px;
- an 11–18 integer range input with the exact numeric value visible;
- compact color swatches plus native `<input type="color">`;
- a `theme` button and per-role reset;
- a live sample rendered with the selected size and resolved color.

The parent emits partial role updates only; it must never synthesize or overwrite untouched sibling values.

- [ ] **Step 5: Add compact panel styles**

Add styles under `.financial-display-settings` using the existing panel tokens. Keep controls in dense rows, allow wrapping only inside the settings panel at narrow widths, and preserve 44 px minimum pointer targets through padding without forcing card styles to grow.

- [ ] **Step 6: Verify GREEN and commit**

Run:

```bash
/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/FinancialDisplaySettings.test.tsx tests/unit/i18n-catalog.test.ts
```

Expected: component and catalog tests PASS.

Commit:

```bash
git add src/popup/FinancialDisplaySettings.tsx tests/unit/FinancialDisplaySettings.test.tsx src/i18n/catalog.ts tests/unit/i18n-catalog.test.ts entrypoints/sidepanel/sidepanel.css
git commit -m "feat: add financial appearance controls"
```

### Task 4: Wire settings updates through the side panel

**Files:**
- Modify: `src/popup/SettingsPanel.tsx`
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `tests/unit/SettingsPanel.test.tsx`
- Modify: `tests/unit/SidePanelApp.test.tsx`

- [ ] **Step 1: Write failing integration tests**

Update the expected settings-section count and verify an editor change reaches `LocalPreferences.updateSettings` as a nested partial update. Then rerender from the returned settings and assert the changed control remains selected.

```ts
fireEvent.change(screen.getByRole('slider', { name: 'Sell amount font size' }), {
  target: { value: '17' },
});

await waitFor(() => {
  expect(preferences.updateSettings).toHaveBeenCalledWith({
    financialDisplay: { sellAmount: { fontSizePx: 17 } },
  });
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/SettingsPanel.test.tsx tests/unit/SidePanelApp.test.tsx
```

Expected: FAIL because the panel has no financial-display callback or controls.

- [ ] **Step 3: Integrate the editor**

Add this optional callback to `SettingsPanelProps`:

```ts
onFinancialDisplayChange?(
  update: NonNullable<LocalSettingsUpdate['financialDisplay']>,
): void;
```

Render `FinancialDisplaySettings` as its own `settings-section`. In `SidePanelApp`, add a callback that passes `{ financialDisplay: update }` to the existing settings update path and only replaces local state with the validated persisted result.

- [ ] **Step 4: Verify GREEN and commit**

Run:

```bash
/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/SettingsPanel.test.tsx tests/unit/SidePanelApp.test.tsx
```

Expected: all settings integration tests PASS.

Commit:

```bash
git add src/popup/SettingsPanel.tsx src/sidepanel/SidePanelApp.tsx tests/unit/SettingsPanel.test.tsx tests/unit/SidePanelApp.test.tsx
git commit -m "feat: wire financial display preferences"
```

### Task 5: Apply role-specific values without changing card geometry

**Files:**
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `src/popup/EventCard.tsx`
- Modify: `entrypoints/sidepanel/sidepanel.css`
- Modify: `tests/unit/EventCard.test.tsx`
- Modify: `tests/e2e/live-feed.spec.ts`

- [ ] **Step 1: Write failing rendering tests**

Render buy and sell events using intentionally distinct colors and sizes. Assert the side-panel root exposes six resolved custom properties and that the card roles consume the correct pair:

```ts
expect(root).toHaveStyle({
  '--buy-amount-font-size': '16px',
  '--buy-amount-color': '#18D79C',
  '--sell-amount-font-size': '14px',
  '--sell-amount-color': '#FF6577',
  '--market-cap-font-size': '11px',
  '--market-cap-color': '#A6B3C8',
});
```

Also assert `theme` resolves to the current theme token rather than a hard-coded hex value.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```bash
/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/EventCard.test.tsx tests/unit/SidePanelApp.test.tsx
```

Expected: FAIL because role-specific custom properties are not applied.

- [ ] **Step 3: Expose safe CSS custom properties**

Build the root style object only from already validated settings:

```ts
const financialStyle = {
  '--buy-amount-font-size': `${settings.financialDisplay.buyAmount.fontSizePx}px`,
  '--buy-amount-color': resolveFinancialColor(settings.financialDisplay.buyAmount.color, 'buy'),
  '--sell-amount-font-size': `${settings.financialDisplay.sellAmount.fontSizePx}px`,
  '--sell-amount-color': resolveFinancialColor(settings.financialDisplay.sellAmount.color, 'sell'),
  '--market-cap-font-size': `${settings.financialDisplay.marketCap.fontSizePx}px`,
  '--market-cap-color': resolveFinancialColor(settings.financialDisplay.marketCap.color, 'marketCap'),
} as React.CSSProperties;
```

Use existing theme variables for `theme`: buy and sell amounts both follow the current primary text color, while market cap follows the current secondary text color. This preserves the pre-migration appearance; users can then assign distinct buy/sell colors explicitly.

- [ ] **Step 4: Consume variables by event role**

Keep the existing markup and use the already-present action classes:

```css
.event-card-buy .event-amount {
  color: var(--buy-amount-color);
  font-size: var(--buy-amount-font-size);
}

.event-card-sell .event-amount {
  color: var(--sell-amount-color);
  font-size: var(--sell-amount-font-size);
}

.event-market-cap {
  color: var(--market-cap-color);
  font-size: var(--market-cap-font-size);
}
```

Keep `.event-financials` single-line with tabular numerals and no new margins, padding, or line-height expansion. Opinion/transfer events without amounts remain unchanged.

- [ ] **Step 5: Add density browser coverage**

In Playwright, customize all three roles, close and reopen settings, reload the page, and assert the values persist. Measure the same fixture card before and after customization; the 18 px maximum may not increase its bounding-box height or reduce the established minimum visible-card count.

- [ ] **Step 6: Run full verification and commit**

Run:

```bash
git diff --check
/usr/local/bin/node node_modules/typescript/bin/tsc --noEmit
/usr/local/bin/node node_modules/vitest/vitest.mjs run
/usr/local/bin/node node_modules/wxt/bin/wxt.mjs build
/usr/local/bin/node node_modules/@playwright/test/cli.js test tests/e2e/live-feed.spec.ts
```

Expected: typecheck, all tests, production build, persistence scenario, and density checks PASS.

Commit:

```bash
git add src/sidepanel/SidePanelApp.tsx src/popup/EventCard.tsx entrypoints/sidepanel/sidepanel.css tests/unit/EventCard.test.tsx tests/unit/SidePanelApp.test.tsx tests/e2e/live-feed.spec.ts
git commit -m "feat: apply financial display preferences"
```
