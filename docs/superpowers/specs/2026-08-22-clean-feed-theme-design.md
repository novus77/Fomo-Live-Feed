# Clean Feed and Theme Design

## Goal

Make the Side Panel a quieter, information-only feed while preserving the
underlying annotation and automatic-translation capabilities. Add a persisted
light/dark appearance choice in Settings without changing the default look for
existing users.

## Scope

### Feed cards

- Remove the visible annotation label, the `Label` / `Close` button, and the
  inline annotation editor from every history card.
- Keep `annotations.v1`, `TraderAnnotationV1`, `LocalPreferences` annotation
  methods, and query-time annotation behavior intact. No stored annotation is
  deleted or migrated.
- Keep trader identity, action, token, chain, amount, opinion translation, CA,
  navigation, and copy behavior unchanged.

### Header

- Keep exactly two visible controls in the right-side header group: Refresh
  and Settings.
- Remove the visible refresh status text, including `Ready` / `就绪`.
- Keep the spinning refresh icon and disabled state while a sync is running.
- Preserve status accessibility through a visually-hidden `role="status"`
  region and state-specific button title/accessible name.

### Translation settings

- Remove the `Initialize local translation` button, setup progress, and setup
  status block from Settings.
- Remove SidePanel state and callbacks that exist only for that setup surface.
- Keep automatic opinion translation, its enabled toggle, target-language
  selector, content-script translation host, fallback gateway, retry behavior,
  and per-card translation output unchanged.

### Theme settings

- Add `UiTheme = 'light' | 'dark'` to settings V4, persisted under
  `settings.v4`.
- Default and all V1/V2/V3 migrations select `dark`, preserving the current
  appearance for existing users.
- Keep legacy settings keys for rollback, following the existing migration
  policy.
- Settings shows an icon-only two-button group: a sun selects `light`; an
  illuminated moon selects `dark`. Both buttons have localized accessible
  names and `aria-pressed` state.
- The Side Panel applies `data-theme="light|dark"` at its root. Theme changes
  update immediately and propagate through the existing storage change
  listener.
- Both themes use semantic CSS custom properties. Light mode changes surfaces,
  borders, foregrounds, inputs, and secondary text while retaining semantic
  buy/sell colors and chain brand colors.
- Theme affects the Side Panel only. Trading-page toast styling remains
  unchanged.

## Persistence and compatibility

`LocalSettingsV4` retains every V3 field and adds `uiTheme`. Reads prefer a
valid V4 record, then migrate V3, V2, or V1. Updates remain serialized through
the existing `LocalPreferences` write queue so locale, translation, and theme
changes cannot overwrite one another.

## Accessibility

- Removed annotation controls must not remain hidden in the DOM or keyboard
  tab order.
- Sun, moon, refresh, and settings controls have localized `aria-label` and
  `title` text.
- Selected theme uses `aria-pressed`; color is not the only state indicator.
- Refresh outcomes remain announced without consuming visible header space.
- Light and dark variables must maintain readable foreground/background and
  focus-ring contrast.

## Verification

- Unit tests cover card cleanup, header cleanup, translation-settings cleanup,
  theme selection, persistence, migration, storage synchronization, and
  accessibility state.
- CSS contract tests cover both theme selectors and the absence of obsolete
  label/status/setup selectors.
- Real extension E2E verifies two header controls, no label UI, no translation
  initialization button, immediate light/dark switching, persistence after a
  Side Panel reopen, and unchanged automatic opinion translation.
- Release gates remain `CI=true corepack pnpm check` and
  `CI=true corepack pnpm test:e2e`.

## Non-goals

- Deleting annotation data or annotation APIs.
- Removing automatic translation or its preferences.
- Following the operating-system theme automatically.
- Theming trading-page toast overlays.
- Redesigning feed content, spacing, or typography beyond theme tokens.
