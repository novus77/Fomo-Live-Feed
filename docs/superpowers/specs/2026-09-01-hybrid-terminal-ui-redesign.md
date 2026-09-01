# Hybrid Terminal UI Redesign

## Goal

Redesign the complete Chrome Side Panel experience without reducing the number
of feed items visible in the current viewport. The approved visual direction is
a hybrid of:

- the restrained structure, typography, spacing, and motion of a professional
  trading terminal; and
- event-specific colored borders inspired by crypto-native interfaces.

The redesign covers the header, connection state, toolbar, feed cards, filter
popover, settings and support views, loading states, empty states, error states,
and interaction feedback. It does not change event ingestion, filtering rules,
storage, navigation, translation, or notification behavior.

## Design principles

1. **Density is a feature.** No feed card may become taller than its current
   equivalent. The same viewport must show at least as many complete cards as
   the current release.
2. **Color communicates event type.** Color is reserved for event identity,
   live status, and actionable feedback. It is not decorative ambient light.
3. **Stable geometry.** Hover, press, loading, and arrival animations must not
   move surrounding cards or change layout dimensions.
4. **Numbers scan vertically.** Amount and market-cap values use tabular or
   monospaced numerals and stable alignment.
5. **Motion adds information.** Every animation must communicate press,
   progress, arrival, success, or state transition.
6. **Accessible by default.** Color never replaces text labels, focus remains
   visible, and `prefers-reduced-motion` removes spatial motion.

## Visual system

### Foundation

- Background: near-black navy rather than pure black.
- Header and controls: slightly elevated navy surfaces separated by low-contrast
  one-pixel rules.
- Cards: compact dark surfaces with a one-pixel event-colored outline and a
  two-pixel stronger left edge.
- Corners: 7 px for feed cards and 8 px for controls and popovers. Avoid
  oversized pill-shaped cards.
- Shadows: limited to overlays and popovers. Feed cards do not use persistent
  drop shadows.
- Typography: the existing UI font remains the default. Amounts, market caps,
  addresses, counters, and diagnostics use tabular or monospaced numerals.

The initial implementation uses these reference tokens, adjusted only when an
automated contrast check requires a lighter foreground:

| Token | Dark | Light |
| --- | --- | --- |
| Canvas | `#090D13` | `#F4F6F9` |
| Raised surface | `#0D131C` | `#FFFFFF` |
| Control surface | `#121A25` | `#EEF2F6` |
| Primary text | `#F3F7FF` | `#121923` |
| Secondary text | `#8997AA` | `#5D697A` |
| Neutral rule | `#202B39` | `#D8DEE7` |
| Buy accent | `#31D399` | `#087F5B` |
| Sell accent | `#F16D79` | `#C92A3A` |
| Opinion accent | `#7EA7FF` | `#315FBD` |
| Transfer accent | `#E0A84B` | `#946200` |
| Withdraw accent | `#8997AA` | `#5D697A` |

### Event colors

| Event | Accent | Usage |
| --- | --- | --- |
| Buy | Emerald | Action badge, one-pixel card outline at about 32% opacity, two-pixel left edge, amount emphasis |
| Sell | Coral red | Action badge, one-pixel card outline at about 31% opacity, two-pixel left edge, amount emphasis |
| Opinion | Signal blue | Action badge, one-pixel card outline at about 32% opacity, two-pixel left edge, thesis emphasis |
| Transfer | Amber | Text badge and restrained border while remaining independent of buy/sell/opinion filters |
| Withdraw | Slate | Text badge and restrained border while remaining independent of buy/sell/opinion filters |

Every text/background pair must meet WCAG AA contrast. Every action remains
explicitly labeled, so event meaning is not conveyed by color alone.

## Side Panel structure

### Header and connection state

The header remains one compact row:

- product mark and `Fomo Live Feed` title;
- live connection dot and localized state label;
- filter, refresh, settings, and support controls aligned on the right.

Connected uses emerald. Reconnecting uses amber with a non-looping or very
subtle progress treatment. Offline and login-required use explicit text and an
action; they must never resemble a healthy live state.

### Toolbar controls

Toolbar buttons use a 30–32 px square hit area, a visible focus ring, a subtle
surface on hover, and a brief press scale. Support remains an icon-only heart
with the localized tooltip. Filter retains its funnel icon and active-count
indicator. Refresh performs one rotation only when a refresh begins.

### Feed cards

The card hierarchy remains compact:

1. Avatar, display name, handle, action badge, and relative time on one row.
2. Token symbol, chain badge, transaction amount, and `MC:` value on one row.
3. Optional thesis and translation rows only for opinion content.
4. CA and copy control aligned on the address row.

Missing optional values remain absent instead of rendering placeholders. Token
and trader links retain their current interaction boundaries. The card body
does not become clickable.

The full outline identifies the event category at a glance. The stronger left
edge preserves the fast vertical scan axis used by terminal-style feeds.

### Chain icons

The six supported chains use the approved SVG assets in `图标/svg/`:

- `bsc.svg`
- `solana.svg`
- `base.svg`
- `robinhood.svg`
- `ethereum.svg`
- `xlayer.svg`

The implementation copies these source assets into the extension's packaged
public asset directory without raster conversion. Chain icons appear in exactly
two product contexts:

1. before the abbreviated chain label in each feed card; and
2. before the full chain label in each chain-filter button.

Feed icons render at 12 px inside the existing compact chain badge. Filter icons
render at 16 px. Both use a square box, `object-fit: contain`, and no additional
background beyond the badge or button surface. The adjacent text label remains
visible, so the icon is decorative and uses an empty alternative description.
The icons must not increase the height of either the card metric row or filter
button.

### Filter popover

The filter popover uses the same elevated navy surface and compact control
height as the header. It contains:

- independent buy, sell, and opinion toggles;
- the market-cap range inputs in `K` units;
- the persistent six-chain selector;
- select-all, deselect-all, and reset actions.

Selected states use the relevant semantic color only where it improves
recognition. Chain colors stay muted. The popover must fit the narrow Side Panel
without horizontal clipping and must not cover its own trigger.

### Settings and support

Settings and support use compact sections separated by rules rather than a
stack of large cards. Toggle rows retain at least a 32 px hit height. Buy-sound
and translation settings show immediate state feedback without changing the
surrounding layout. Diagnostics use monospaced values and clear healthy,
degraded, and unavailable labels.

## Loading, empty, and failure states

### Initial loading

Render fixed-height skeleton rows matching the final card geometry. Skeletons
must not shimmer continuously. A single low-contrast opacity sweep is allowed;
reduced-motion mode uses a static skeleton.

### Refreshing with existing data

Keep existing cards visible. Animate only the refresh icon and a compact status
label. Never replace the feed with a full-page spinner.

### Empty states

Use a small icon, one clear sentence, and one relevant recovery action. Separate
copy is required for:

- connected with no events;
- no chain selected;
- filters with no matches;
- no authenticated Fomo tab.

Empty states must remain visually quiet and vertically compact.

### Errors

Keep valid existing data visible when refresh or persistence fails. Show a
compact inline error with a retry action. Connection failures use the header
state plus a concise recovery message; they do not use destructive red unless
the user must act.

## Motion specification

| Interaction | Motion | Duration |
| --- | --- | --- |
| Toolbar press | Scale from 1 to 0.92–0.96 and return | 120–150 ms |
| Hover / selected control | Background, border, and foreground color transition | 120–160 ms |
| Refresh | One icon rotation, tied to refresh start | 450–600 ms |
| Popover open | Opacity plus 2–4 px downward-to-rest transition | 160–190 ms |
| New live event | Opacity plus 4–6 px upward-to-rest; event border pulse fades once | 500–700 ms |
| Copy success | Icon morph or color confirmation without width change | 160–220 ms |
| Toggle | Thumb movement and semantic color transition | 140–180 ms |

Easing uses a fast-out, slow-in curve such as
`cubic-bezier(0.2, 0.8, 0.2, 1)`. No animation blocks input. No feed item uses
continuous glow, bounce, particle effects, marquee motion, or repeating pulse.

Under `prefers-reduced-motion: reduce`, spatial translation, scale, and rotation
are removed. State feedback remains available through color, text, icon, and
focus changes.

## Component boundaries

The implementation should introduce reusable visual primitives rather than
adding isolated CSS to each screen:

- semantic surface and border tokens;
- event-type presentation tokens;
- compact icon button;
- compact state badge;
- feed-card shell;
- skeleton card;
- inline status and recovery state.

Existing domain components keep their current data and behavior contracts. The
redesign is a presentation-layer change, which limits regression risk and makes
each visual primitive independently testable.

## Validation

### Visual regression

- Compare the current and redesigned Side Panel at supported narrow widths.
- Confirm that every viewport shows at least the same number of complete feed
  items for equivalent content.
- Verify dark and light themes, long names, long symbols, missing values, thesis
  translation, and every supported chain badge.
- Verify all six SVG chain icons at 1× and 2× display scaling, including their
  contrast on dark and light surfaces.

### Interaction

- Verify toolbar focus, hover, press, and keyboard activation.
- Verify filter popover placement and focus restoration.
- Verify new-event, refresh, copy, toggle, and reduced-motion behavior.
- Confirm no animation causes layout shift or delays input.

### Functional regression

- Run the existing unit, integration, and Playwright suites.
- Keep existing tests for filtering, persistence, translation, navigation,
  buy-sound delivery, connection state, and event rendering unchanged wherever
  behavior is unchanged.
- Add focused component tests for semantic event classes, reduced-motion CSS,
  loading geometry, and compact empty/error states.

## Out of scope

- Changes to event ingestion, storage, retention, or message protocols.
- New data fields, charts, prices, or external market-data requests.
- A user-selectable theme editor or multiple visual skins.
- Persistent ambient glow, animated backgrounds, particles, or sound changes.
- Any increase in feed-card height or decrease in information density.
