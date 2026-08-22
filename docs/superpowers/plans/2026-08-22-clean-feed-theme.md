# Clean Feed and Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove nonessential feed controls and setup status while adding a persisted light/dark Side Panel theme.

**Architecture:** Preserve annotation and translation services below the UI boundary, and delete only their obsolete visible surfaces. Introduce `LocalSettingsV4` with a serialized V1/V2/V3→V4 migration, pass the selected theme through the existing settings state, and style the Side Panel through root-scoped semantic CSS variables.

**Tech Stack:** TypeScript, React 19, Zod, chrome.storage.local, CSS custom properties, Vitest/Testing Library, Playwright, WXT.

---

### Task 1: Remove annotation UI from feed cards

**Files:**
- Modify: `src/popup/EventCard.tsx`
- Modify: `entrypoints/sidepanel/sidepanel.css`
- Test: `tests/unit/EventCard.test.tsx`
- Test: `tests/unit/HistoryFeed.test.tsx`

- [x] **Step 1: Write failing card tests**

Add assertions that a card with an existing annotation renders neither the
annotation label nor an Edit/Label button, that no annotation editor can enter
the DOM, and that token navigation, translation, and CA copy remain available.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
CI=true corepack pnpm vitest run tests/unit/EventCard.test.tsx tests/unit/HistoryFeed.test.tsx
```

Expected: FAIL because the current card renders `.event-trader-label` and
`.event-edit-label`.

- [x] **Step 3: Remove only the presentation boundary**

Delete `showEditor`, label styling, the visible annotation label, editor toggle,
and `TraderAnnotationEditor` rendering/import from `EventCard`. Retain the
annotation props and callbacks on the public component boundary so annotation
storage/query contracts remain available for a future UI.

- [x] **Step 4: Remove obsolete label/editor CSS selectors**

Delete selectors used only by the removed card surface; do not remove shared
card, identity, action, translation, or CA styles.

- [x] **Step 5: Run focused tests and verify GREEN**

Run the Task 1 command. Expected: both files pass.

### Task 2: Make refresh icon-only and remove translation setup UI

**Files:**
- Modify: `src/sidepanel/RefreshButton.tsx`
- Modify: `src/popup/SettingsPanel.tsx`
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `entrypoints/sidepanel/sidepanel.css`
- Modify: `src/i18n/catalog.ts`
- Test: `tests/unit/RefreshButton.test.tsx`
- Test: `tests/unit/SettingsPanel.test.tsx`
- Test: `tests/unit/SidePanelApp.test.tsx`

- [x] **Step 1: Write failing cleanup and accessibility tests**

Assert that idle/updated/current states have no visible status text; the
refresh button still exposes localized status and spins while syncing. Assert
that Settings contains no initialization button/progress/status, while the
automatic-translation toggle and target selector still work.

- [x] **Step 2: Run focused tests and verify RED**

```bash
CI=true corepack pnpm vitest run tests/unit/RefreshButton.test.tsx tests/unit/SettingsPanel.test.tsx tests/unit/SidePanelApp.test.tsx
```

Expected: FAIL on visible refresh status and translation setup controls.

- [x] **Step 3: Implement the minimal UI cleanup**

Replace the visible refresh status with a visually-hidden live region. Remove
`translationSetup`, `onInitializeTranslation`, the setup message map, progress
markup, and setup-only SidePanel state/callback/imports. Do not change the
translation enabled/target settings or translation coordinator used by cards.

- [x] **Step 4: Remove obsolete CSS and catalog entries**

Delete `.refresh-status-*` presentation rules and translation setup control
styles. Remove i18n messages that have no remaining runtime reference, while
keeping automatic translation failure/activation messages used by cards.

- [x] **Step 5: Run focused tests and verify GREEN**

Run the Task 2 command. Expected: all three files pass.

### Task 3: Add versioned persisted theme settings

**Files:**
- Modify: `src/domain/settings.ts`
- Modify: `src/storage/local-preferences.ts`
- Modify: `src/i18n/LocaleProvider.tsx`
- Modify: all consumers that currently name `LocalSettingsV3`
- Test: `tests/unit/local-preferences.test.ts`
- Test: `tests/unit/LocaleProvider.test.tsx`
- Test: `tests/unit/ingest-activity.test.ts`

- [x] **Step 1: Write failing V4 schema and migration tests**

Cover a V4 round trip, dark defaults, V3→V4 preservation, V2/V1→V4
migration, corrupt V4 fallback, retained legacy keys, theme-only updates, and
concurrent locale/translation/theme updates.

- [x] **Step 2: Run focused storage tests and verify RED**

```bash
CI=true corepack pnpm vitest run tests/unit/local-preferences.test.ts tests/unit/LocaleProvider.test.tsx tests/unit/ingest-activity.test.ts
```

Expected: FAIL because `UiTheme`, `LocalSettingsV4`, and `settings.v4` do not
exist.

- [x] **Step 3: Implement V4 and migrations**

Add:

```ts
export type UiTheme = 'light' | 'dark';

export interface LocalSettingsV4 {
  schemaVersion: 4;
  notifications: LocalSettingsV3['notifications'];
  filters: LocalSettingsV3['filters'];
  uiLocale: UiLocale;
  uiTheme: UiTheme;
  opinionTranslation: LocalSettingsV3['opinionTranslation'];
}
```

Add strict theme validation, `settings.v4`, V3-first legacy fallback, and
migrations that preserve every existing field while adding `uiTheme: 'dark'`.
Update the settings update type with `uiTheme?: UiTheme`. Rename active runtime
consumer types to V4 without changing their business behavior.

- [x] **Step 4: Run focused storage tests and verify GREEN**

Run the Task 3 command. Expected: all files pass.

### Task 4: Add Settings sun/moon theme control and apply root theme

**Files:**
- Modify: `src/popup/SettingsPanel.tsx`
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `entrypoints/sidepanel/sidepanel.css`
- Modify: `src/i18n/catalog.ts`
- Test: `tests/unit/SettingsPanel.test.tsx`
- Test: `tests/unit/SidePanelApp.test.tsx`

- [x] **Step 1: Write failing theme UI tests**

Assert that Settings renders icon-only sun/moon buttons, exposes localized
names and titles, reports selection with `aria-pressed`, calls the settings
update with `light`/`dark`, and applies `data-theme` to `.sidepanel-root`.
Simulate a storage change and verify an open panel changes theme immediately.

- [x] **Step 2: Run focused UI tests and verify RED**

```bash
CI=true corepack pnpm vitest run tests/unit/SettingsPanel.test.tsx tests/unit/SidePanelApp.test.tsx
```

Expected: FAIL because no theme controls or root theme attribute exist.

- [x] **Step 3: Implement theme behavior**

Add `onThemeChange(theme)` to `SettingsPanel`, render local SVG sun/moon icons,
and persist changes through `LocalPreferences.updateSettings({ uiTheme })`.
Render `data-theme={settings.uiTheme}` on the Side Panel root. Reuse the
existing storage listener to adopt cross-context changes.

- [x] **Step 4: Convert Side Panel styling to semantic tokens**

Define complete dark and light values at `.sidepanel-root[data-theme]` for
page/card/control/input surfaces, primary/secondary/muted text, borders,
hover/focus, and code/address backgrounds. Replace hard-coded neutral colors
in the Side Panel with those variables, while leaving buy/sell and chain colors
unchanged.

- [x] **Step 5: Run focused UI tests and verify GREEN**

Run the Task 4 command. Expected: both files pass.

### Task 5: Update real-extension E2E and release verification

**Files:**
- Modify: `tests/e2e/live-feed.spec.ts`
- Modify: `tests/e2e/fixture-server.ts` only if an existing fixture cannot expose an English thesis
- Modify: `docs/manual-testing.zh-CN.md`

- [x] **Step 1: Extend the Side Panel E2E contract**

Using the existing real action-click/Side Panel helpers, assert exactly two
visible header buttons; absence of label UI and translation initialization;
automatic English-opinion translation; sun→light immediate switch; Side Panel
close/reopen persistence; and moon→dark restoration.

- [x] **Step 2: Run the complete project gate**

```bash
CI=true corepack pnpm check
```

Expected: typecheck, all Vitest files, and WXT production build pass.

- [x] **Step 3: Run real Chromium E2E**

```bash
CI=true corepack pnpm test:e2e
```

Expected: all Playwright extension tests pass with no popup fallback and no
manual page reload.

- [x] **Step 4: Perform final hygiene checks**

```bash
git diff --check
rg -n "event-edit-label|event-trader-label|translation-initialize|refresh-status-" src entrypoints
```

Expected: clean diff; no obsolete runtime selectors or controls.

- [x] **Step 5: Update manual testing documentation**

Document the two-control header, intentionally hidden annotation UI, automatic
translation without initialization, and persisted sun/moon theme checks.
