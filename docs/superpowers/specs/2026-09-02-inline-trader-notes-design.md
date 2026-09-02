# Inline Trader Notes Design

## Goal

Expose the existing per-trader annotation label directly beside the trader name so users can add and edit a short private note without leaving the feed or increasing card height.

## Existing Foundation

`TraderAnnotationV1.label` already stores an optional, trimmed label of at most 40 characters under the stable Fomo `traderId`. Annotation updates persist in `chrome.storage.local`, propagate through the side panel, and participate in feed search. This feature reuses that contract and does not add a second note store.

## Display

- Keep trader name, note control, and relative time on the existing first identity row.
- Show a compact `＋备注` control after the name when no label exists.
- Show the saved label as a compact chip after the name when present.
- Keep relative time right-aligned and non-shrinking.
- Allow the name and note chip to shrink independently. Ellipsize long notes and expose the full note with `title` and an accessible label.
- Preserve the current card height and second-line handle placement.

## Editing

- Selecting `＋备注` or an existing note chip replaces that control with one single-line input in the same row.
- The note control must stop propagation and must not trigger the trader-profile link.
- `Enter` validates and saves; `Escape` cancels and restores the prior value.
- Blur saves a valid draft. An empty or whitespace-only value clears the label.
- Invalid values remain editable and display the localized 40-character validation message without persisting.
- A successful update refreshes every visible card for the same `traderId` immediately.

## Accessibility and Safety

- The add, edit, save, and validation states use localized accessible names.
- The input receives focus and selects the existing note when editing begins.
- User-authored text is rendered only as text, never as HTML.
- Keyboard operation covers add, edit, save, cancel, clear, and profile-link isolation.

## Verification

Cover empty, saved, long, cleared, invalid, keyboard, blur, propagation, search, and narrow-width states in unit and browser tests. Density assertions must confirm that a note does not add another card row.
