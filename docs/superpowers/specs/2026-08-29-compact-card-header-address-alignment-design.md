# Compact Event Card Header and Address Alignment

## Goal

Reduce the vertical footprint of each event card while preserving scanability and keeping the contract-address copy affordance visually attached to the address itself.

## Scope

- Move the relative event time from the action row to the trader-name row.
- Keep the time immediately after the trader name.
- Align the copy button with the displayed contract address rather than with the `CA:` label.
- Preserve existing event content, navigation, copy behavior, validation, accessibility, and error feedback.

## Header Layout

The trader identity keeps its existing avatar and two-line text structure.

The first text line contains:

1. Trader display name.
2. Relative event time, immediately after the name.

The second text line continues to contain the trader handle and optional follower count.

The name may truncate when horizontal space is limited. The relative time must remain fully visible and must not wrap. The time is removed from `.event-action-line`, so it never creates an additional action-row item or a separate visual line.

## Action Layout

The action row continues to contain only:

- Action badge.
- Token identity group: token image, symbol, and chain badge.
- Financial group: event amount and event market cap when available.

Existing narrow-width wrapping behavior remains unchanged. The token identity group stays indivisible.

## Contract Address Layout

`CopyableAddress` separates the extension-owned label from the address value:

- `.copyable-address-label` renders `CA:`.
- `.copyable-address-value` renders only the canonical address and remains the keyboard-accessible copy target.
- `.copyable-address-button` follows the address value and aligns to the address text's vertical center/baseline.

The container uses a three-part layout: label, truncatable address, and copy button. The address may truncate at narrow widths. The button must remain visible and adjacent to the displayed address region.

Invalid addresses remain non-interactive. They use the same split label/value presentation but do not render a copy button.

## Localization

The `CA:` label continues to come from the existing locale catalog. No new user-facing strings are introduced. Relative time continues to use the existing localized formatter.

## Accessibility and Interaction

- The canonical address remains keyboard focusable and supports Enter/Space copying.
- The copy button keeps its existing localized accessible name and title.
- Clicking the address area or copy button must not trigger card navigation.
- Copy success and failure feedback behavior remains unchanged.

## Testing

Unit tests must verify:

- Relative time is rendered inside the trader-name row and absent from the action row.
- The trader handle remains on the second line.
- `CopyableAddress` renders separate label and address nodes.
- Valid addresses remain clickable and keyboard accessible.
- Invalid addresses remain non-interactive without a copy button.

The 280px E2E layout check must verify:

- The trader name and relative time share one visual row.
- The relative time is visible and within the card/viewport bounds.
- The address and copy button are visible, adjacent, vertically aligned, and within the card/viewport bounds.
- No horizontal overflow is introduced.

## Non-Goals

- No changes to event ingestion, schemas, persistence, market-cap data, translation, permissions, authentication, or network requests.
- No change to card navigation or copy semantics.
- No redesign of avatar, action badge, token identity, financial formatting, thesis content, or feedback timing.
