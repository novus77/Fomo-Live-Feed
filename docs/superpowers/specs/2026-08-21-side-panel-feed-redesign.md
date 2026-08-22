# Fomo Live Feed — Side Panel and Reliability Redesign

## 1. Purpose

Replace the constrained toolbar Popup with a persistent Chrome Side Panel,
reduce filter chrome, improve actionable token metadata, and make missing or
delayed activity diagnosable before adding any speculative recovery source.

The in-page toast stack remains the real-time interruption surface. The Side
Panel becomes the sole full history, search, filtering, annotation, and
settings surface.

## 2. Confirmed Product Decisions

- Clicking the extension action opens the Chrome Side Panel.
- The existing full Popup is removed; no duplicated Popup/Side Panel product
  surface is maintained.
- The Side Panel is globally available so it can remain open while the user
  changes tabs. It does not expand content-script host permissions.
- Search occupies its own top row.
- Six filter concepts are collapsed into one compact toolbar and active chips.
- Connection status is always visible.
- Every event card displays an accessible chain badge and an explicit CA row.
- Settings uses a gear icon with an accessible text label.
- No REST backfill is enabled until a real authenticated endpoint and response
  contract have been captured, redacted, and verified.

## 3. Architecture

```text
Authenticated Fomo page
  → MAIN-world WebSocket observer
  → isolated bridge
  → service worker ingest / validation / deduplication
  → IndexedDB event history
       ├── supported-site toast stack
       └── Chrome Side Panel history UI
```

### Side Panel integration

- Add a WXT `entrypoints/sidepanel/` entrypoint that builds
  `/sidepanel.html`.
- Add the Chrome `sidePanel` permission and generated `side_panel.default_path`.
- Configure `sidePanel.setPanelBehavior({ openPanelOnActionClick: true })` in
  the background worker.
- Remove the Popup entrypoint so the action click is not captured by
  `default_popup`.
- Reuse the existing feed repositories, runtime protocol, hooks, cards,
  settings, and annotations. Presentation-specific layout belongs to the Side
  Panel entrypoint, not the storage or background layers.
- Target Chrome 114 or later, the minimum version supporting the Side Panel
  API. Feature detection must produce a clear unsupported-browser diagnostic.

The Side Panel is an extension page and does not need `<all_urls>` or broad
host access. Existing Fomo, DexScreener, and GMGN host permissions remain
explicit.

## 4. Information Architecture

The Side Panel renders these sections in order:

1. Header: product name, permanent connection indicator, gear button.
2. Search input.
3. Compact filter toolbar.
4. Active filter chips, rendered only when at least one filter is active.
5. Connection/recovery guidance when needed.
6. Newest-first activity feed.

### Permanent connection indicator

Exactly one state is visible at all times:

- `Connected`
- `Reconnecting`
- `Offline`
- `Login required`
- `Checking…` during initial query

The indicator uses text, icon, and color together and exposes `role="status"`.
Detailed banners remain for non-connected states. State updates come from the
initial `connection.query`, live `connection.changed`, and the existing
30-second bounded re-query.

## 5. Search and Filter Interaction

### Search row

Search remains always visible and supports trader name/handle, custom label,
token symbol, and contract address.

### Compact toolbar

One horizontal row contains:

- `Filters` button with active-count badge.
- `Unread` toggle.
- `Pinned` toggle.
- `Reset` action, visible only when a search/filter/sort selection is active.

The `Filters` button opens an anchored popover containing the four selectors:

- Action
- Chain
- Trader
- Token

The popover must support keyboard navigation, Escape dismissal, focus return,
and outside-click dismissal.

### Active chips

Selections render below the toolbar as removable chips, for example:

```text
Buy ×   BSC ×   @theveeman ×
```

Removing one chip clears only that condition. `Reset` restores the complete
default query. An empty chip row consumes no vertical space.

## 6. Event Card Redesign

### Primary content

Each card shows:

- Trader avatar, name/handle, and optional user annotation.
- Buy/sell/thesis action.
- Token image and symbol.
- Chain badge.
- USD amount and relative event time.
- Configured metric slots, including honest unavailable states.

### Chain presentation

A centralized presentation map owns the label, accessible icon, and color:

| Chain | Label | Visual direction |
| --- | --- | --- |
| BSC | BSC | Yellow/gold |
| Ethereum | ETH | Blue-violet |
| Solana | SOL | Purple with green accent |
| Base | Base | Blue |
| Monad | Monad | Purple |
| Unknown | Unknown | Neutral gray |

Icons are bundled local SVG assets or components. Remote icon loading is not
allowed. Text labels remain visible, so color is never the only signal.

### Contract address row

Every event with a valid address renders:

```text
CA: <full canonical contract address>  [copy]
```

- The full address is present in selectable text and may wrap in narrow panels.
- The address and copy button both copy the full canonical value.
- Copy does not trigger card navigation.
- Success produces a short `Copied` status; failure produces a non-blocking
  accessible error.
- Invalid or unknown-chain addresses render as non-clickable text with no
  trusted token-navigation URL. They must not silently disappear.

### Settings action

Replace the `Settings` text button with a local gear SVG. Keep
`aria-label="Settings"`, title/tooltip text, visible focus treatment, and a
  minimum 32×32 CSS-pixel target.

## 7. Delayed and Missing Activity Investigation

The current observation is that the plugin can show one older activity while
newer Fomo activities are absent. This is not yet attributed to a single
component.

### Ranked hypotheses

1. **Pre-existing socket:** the extension was installed/reloaded after Fomo's
   WebSocket was already created. A constructor wrapper cannot observe that
   existing instance until the Fomo page reloads.
2. **Contract drift:** Fomo sends additional topic, action, network, or payload
   shapes rejected by the current narrow parser.
3. **Downstream loss:** the frame is observed but rejected during bridge,
   normalization, deduplication, persistence, or UI querying.

### Safe observability

Add bounded counters and timestamps, never raw payload logging:

- Fomo tab present.
- Observer installed.
- Socket observed/open.
- Last socket frame time.
- Candidate `trading_activity` count.
- Accepted/rejected normalization count.
- Duplicate count.
- Persisted count.
- Broadcast count.
- Latest persisted event timestamp.
- Closed-set rejection code and missing field names only.

Expose a compact diagnostics section from Settings. No cookies, headers,
tokens, wallet balances, theses, arbitrary URLs, or raw frames may be stored.

### Pre-existing socket state

When a Fomo tab exists but the observer has not seen a socket since extension
installation/reload, show:

```text
Refresh the Fomo tab to start live monitoring.
```

Provide an `Open Fomo` action, not an automatic page refresh. The extension
must not reload a trading session without explicit user action.

### REST recovery gate

REST backfill is a separate second-stage fix and remains disabled unless all
conditions pass:

1. A real authenticated request is observed.
2. The response explicitly represents followed-trader activity.
3. Cursor/time semantics are verified.
4. A redacted fixture is committed.
5. Runtime schema validation and deduplication tests pass.
6. No cookie, header, or credential is exported from the browser.

If enabled, recovery requests only activity after the latest persisted cursor,
normalizes through the same canonical pipeline, and relies on stable event IDs
to prevent duplication.

## 8. Error Handling

- Unsupported Side Panel API: show a clear Chrome-version requirement through
  the action fallback rather than failing silently.
- Side Panel query failure: retain controls and show retryable feed error.
- Clipboard failure: preserve selectable CA text and announce failure.
- Missing chain mapping: render `Unknown` plus the raw numeric network ID in
  diagnostics, never guess a chain.
- Observer not attached: show explicit refresh guidance.
- WebSocket disconnected after a confirmed open: show `Reconnecting` while
  preserving read-only history.

## 9. Testing

### Unit and component tests

- Permanent connection indicator for all five UI states and transitions.
- Filter popover open/close, keyboard behavior, and focus return.
- Active chips, single removal, active count, and reset.
- Chain presentation for every `ChainKey`.
- Full CA rendering, wrapping contract, copy success/failure, and event
  propagation.
- Gear button accessibility and settings toggle.
- Observer/socket health state and bounded redacted counters.
- No raw payload or sensitive field can enter diagnostics.

### Integration tests

- Action click opens Side Panel.
- Popup is absent from the production manifest.
- Side Panel reads existing history and reacts to live broadcasts.
- Multiple accepted frames create multiple distinct history rows.
- Every pipeline counter agrees for accepted, rejected, and duplicate frames.
- Existing-socket scenario produces refresh guidance rather than a false
  connected state.

### End-to-end and manual tests

- Build and load the real Side Panel entrypoint in Chromium.
- Keep Side Panel open while switching between Fomo, DexScreener, and GMGN.
- Compare Fomo feed timestamps/counts against stored extension activity.
- Verify burst events, reconnect, duplicate suppression, chain badges, CA copy,
  filters, settings, and browser restart.
- Reinspect the production manifest: `storage` and `sidePanel` permissions only,
  plus the existing four explicit host patterns.

## 10. Acceptance Criteria

1. Clicking the toolbar icon opens the Side Panel, not a Popup.
2. Search, compact filter toolbar, active chips, and history fit a normal Side
   Panel without the old two-row selector block.
3. Connection state is always explicit.
4. Every valid event displays an accessible chain badge and full copyable CA.
5. Settings is represented by an accessible gear icon.
6. Fresh accepted Fomo activities appear in storage and Side Panel within
   seconds, with no silent single-message truncation.
7. When monitoring cannot start because the socket predates injection, the UI
   clearly asks the user to refresh Fomo.
8. Diagnostics identify the pipeline stage of missing activity without
   retaining sensitive data.
9. No speculative REST endpoint or chain mapping is shipped.
10. Unit/integration tests, typecheck, production build, Side Panel E2E, and
    authenticated Chrome manual validation pass before release.

