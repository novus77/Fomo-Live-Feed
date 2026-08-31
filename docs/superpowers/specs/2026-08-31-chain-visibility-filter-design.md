# Chain Visibility Filter Design

## Summary

Add a persistent multi-select chain visibility group to the existing Side Panel feed filter popover. Users can independently enable or disable the six supported product chains. Filtering is reversible and affects presentation only: events continue to be ingested and retained, and live buy sounds remain independent of feed visibility.

## Goals

- Let users show or hide BSC, Solana, Robinhood, Base, Ethereum, and X Layer events.
- Default to all six supported chains enabled.
- Persist the user's selection across extension and browser restarts.
- Keep the compact filter layout readable in the Side Panel.
- Preserve all event data so re-enabling a chain immediately restores its history.
- Hide unknown-chain events from the feed.

## Non-goals

- Per-trader chain preferences.
- Chain-specific sound settings.
- Deleting or suppressing events during ingestion.
- Adding unsupported or unverified chains to the selector.
- Changing the existing action-filter rule that transfer and withdrawal events are not controlled by the buy, sell, and thesis buttons.

## Supported Chains

The selector is a closed set in this order:

1. BSC
2. Solana
3. Base
4. Robinhood (displayed as `RH`)
5. Ethereum
6. X Layer

The canonical keys remain `bsc`, `solana`, `base`, `robinhood`, `ethereum`, and `x-layer`.

`unknown` is not rendered as an option and is always excluded from the feed. Unknown events remain stored so future network evidence or reclassification can recover them.

## State Model and Persistence

The existing `LocalSettingsV4.filters.mutedChains` field remains the persistence source of truth. No settings schema migration is required.

The visible set is derived as:

```text
SUPPORTED_FILTER_CHAINS - normalized(mutedChains)
```

Normalization accepts only the six supported chain keys, removes duplicates, and excludes `unknown`. The default `mutedChains: []` means all six chains are visible.

Chain selection is distinct from transient feed filters such as market-cap range. A toggle updates the feed immediately and persists the complete muted-chain set to `chrome.storage.local`. Rapid updates are serialized or otherwise made last-write-wins so an older write cannot overwrite newer user intent. If persistence fails, the current session selection remains active, a bounded diagnostic is recorded, and the next change retries the complete current state.

## Feed Filtering

Chain visibility is a presentation-time post-filter over retained events. It applies to every action type, including buy, sell, thesis, transfer, and withdrawal.

The existing bounded pagination loop must continue past pages whose rows are removed by chain visibility, subject to its established scan limit. This prevents a sparse selected-chain result from incorrectly terminating on the first non-matching page.

When no chains are selected, the feed returns an empty presentation result without issuing unnecessary paginated history queries. The UI presents a dedicated empty state instead of a connection or data-loading error.

Chain visibility must not affect:

- event ingestion or IndexedDB retention;
- live event broadcasts;
- global buy-sound eligibility or playback;
- token navigation;
- opinion translation;
- trader annotations.

## User Interface

The chain group appears in the existing `FeedFilterPopover` between the action group and the market-cap range.

### Layout

Use the approved two-column checklist layout:

```text
Chain                         Deselect all

[✓] BSC              [✓] Solana
[✓] Base             [✓] RH
[✓] Ethereum         [✓] X Layer
```

Each item is a button with `aria-pressed`. Selected items show a checkmark and highlighted background; unselected items retain a visible boundary and readable label. Keyboard focus uses the existing Side Panel focus treatment.

### Bulk Action

- When all six chains are enabled, the group action reads `Deselect all`.
- Otherwise, it reads `Select all`.
- Deselecting all is valid and produces the dedicated empty feed state.

### Reset and Filter Count

The existing reset button restores all action buttons, all six chains, and an empty market-cap range.

The funnel badge counts active filter groups, not individual values. Chain visibility contributes:

- `0` when all six chains are enabled;
- `1` when one or more chains are disabled, including when all six are disabled.

### Empty State

When all six chains are disabled, show a message equivalent to `No chains selected` and a `Select all chains` action. This state is distinct from an empty history, offline state, login requirement, or failed query.

## Localization

Add English and Simplified Chinese strings for:

- the chain group heading;
- `Select all` / `Deselect all`;
- the no-chains-selected message;
- the `Select all chains` empty-state action.

Chain display labels continue to use the shared chain presentation catalog. Robinhood uses the already approved `RH` abbreviation.

## Error Handling

- Invalid or legacy muted-chain values are ignored during normalization.
- Unknown-chain events are excluded without treating them as malformed.
- Persistence failures do not block feed interaction or revert the current session selection.
- Sparse result scans retain the existing bounded-scan guidance rather than scanning unbounded history.

## Testing

### Unit and Component Tests

- Renders exactly the six supported chain controls in the approved order.
- Toggles each chain independently and exposes correct `aria-pressed` state.
- Select-all and deselect-all produce the expected complete sets.
- Reset restores actions, chains, and market-cap range.
- Active group count treats any non-default chain selection as one group.
- Unknown-chain events are always excluded.
- Chain visibility applies to buy, sell, thesis, transfer, and withdrawal.
- No-chain selection short-circuits history pagination and produces the dedicated empty state.
- Sparse multi-page history continues scanning for selected-chain matches within the existing bound.
- Stored muted chains are normalized and restored.
- Rapid updates persist the latest complete selection.

### Browser E2E Tests

- Open the real extension Side Panel and disable one chain; matching cards disappear while other chains remain.
- Re-enable the chain; its retained history reappears.
- Reload the extension and verify the selection persists.
- Deselect all and verify the dedicated empty state plus select-all recovery action.
- Verify an unknown-chain fixture never renders.
- Verify a live buy on a hidden chain still triggers sound when global sound is enabled.

## Acceptance Criteria

- The filter popover exposes exactly six chain controls in the approved two-column layout.
- All six are enabled for a user with default settings.
- Selection persists across restart and remains reversible because data is retained.
- Unknown events are never displayed.
- All-off state is valid, explicit, and avoids unnecessary page fetching.
- Filtering does not change sound, ingestion, navigation, translation, or annotation behavior.
- Type checking, unit/integration tests, production build, and extension E2E tests pass.
