# English Fomo DOM Fallback Repair Design

## Goal

Ensure Fomo activities recovered from the rendered English feed preserve the real token symbol and token image, and remain visually bounded in the narrow side panel and floating window.

## Context and Root Cause

The authenticated WebSocket/API capture remains authoritative. When that capture is unavailable, the content script enables a DOM recovery observer after a short delay.

The current DOM parser reads two different text representations:

- The surrounding activity text is normalized and used to identify the trader, action, relative time, amount, and market cap.
- The token link's raw `textContent` may be preferred as the ticker when it contains no literal spaces.

On the English page, nested elements can concatenate into values such as `Chino_40Buy...`. The English action matcher requires word boundaries, so the concatenated `Buy` is not recognized. The parser can therefore accept the whole concatenated link text as the ticker. Chinese action labels do not depend on Latin word boundaries and are less likely to trigger the same branch.

DOM recovery candidates also omit `tokenImageUrl`. The UI consequently renders its text fallback. That fallback currently places the complete ticker inside an 18×18 icon box without clipping it, so a malformed ticker paints over the real symbol and produces the visible duplicate-name overlap.

## Chosen Approach

Repair the data at the DOM parser boundary, carry the token image through the existing normalization pipeline, and retain a presentation-level containment guard.

This approach is preferred over:

1. **CSS-only containment:** prevents overlap but persists an incorrect token symbol and does not restore the image.
2. **Disabling DOM recovery:** avoids malformed rows but reintroduces missing real-time activities when authenticated capture is unavailable.

## Parsing Contract

### Token symbol

The token symbol must be derived from the normalized activity sentence after the action and relative timestamp. The parser must not treat an arbitrary concatenated token-link `textContent` value as authoritative.

For the currently supported rendered feed shape:

1. Remove the action prefix.
2. Locate and remove the relative timestamp.
3. Consider only text before the first monetary value.
4. Ignore known separator placeholders such as `?`.
5. Use the final remaining token as the symbol.
6. Reject the candidate when no bounded symbol remains.

This contract works for both localized shapes:

- `pointfarmcap 买入 1分钟 ? BTC $3 以 $337.3万 市值`
- `anyway Sell 2m BNC4 $5 at $4.15M MC`

It also avoids locale-specific interpretation of concatenated descendant text.

### Token image

The DOM observer may attach `tokenImageUrl` only when an image is structurally associated with the token link:

- Prefer an `img[src]` descendant of the token link.
- Do not search an arbitrary ancestor, because that can select the trader avatar.
- Pass the bounded raw URL through the existing Fomo normalization boundary.
- Preserve only the existing accepted forms: absolute HTTPS or root-relative Fomo paths.
- Omit missing, unsafe, malformed, or oversized values without rejecting the trade.

No new remote lookup, cache, permission, or authentication mechanism is introduced.

## Presentation Guard

`TokenImage` must never render an unbounded symbol as icon content. When the image is absent or fails:

- Render a deterministic one-grapheme fallback derived from the token symbol, or `?` when the symbol is empty.
- Keep the fallback inside the existing 18×18 box.
- Apply `overflow: hidden` and `white-space: nowrap` as defense in depth.

The separate token-symbol element retains its existing ellipsis behavior. Card height, row density, and financial layout must not change.

## Data Flow

1. `installFomoDomActivityObserver` finds a supported token link while authenticated capture is unavailable.
2. `parseFomoDomActivity` derives the event fields from normalized activity text and reads only a token-link descendant image.
3. `activity.ingest` sends the recovery candidate through the existing raw schema.
4. `normalizeActivity` resolves and validates `tokenImageUrl` with the existing HTTPS policy.
5. `EventCard` renders the image or a bounded one-grapheme fallback.

The authoritative capture path is unchanged. Existing stable `tradeId` aliasing continues to prevent duplicate insertion when both paths observe the same activity.

## Historical Rows

The repair applies to newly observed activities. Existing malformed rows are not rewritten because the real token symbol cannot be reconstructed safely from persisted contaminated text alone. The presentation guard prevents those rows from painting outside the icon box, and normal retention removes them according to the existing policy.

## Error Handling and Security

- A DOM candidate without a stable `tradeId` remains rejected.
- A DOM candidate without a trustworthy symbol remains rejected rather than persisted with guessed data.
- Image extraction stays scoped to the token link to avoid confusing the trader avatar with the token image.
- Image URL security remains centralized in `normalizeActivity`; the DOM parser does not bypass it.
- Missing images remain non-fatal presentation metadata.

## Verification

### Unit regression coverage

- English nested-span activity whose token link text is concatenated without spaces produces the real ticker, not the trader/action text.
- The same English recovery candidate carries the token image URL when the image is inside the token link.
- Chinese activity parsing remains unchanged.
- Unsafe or missing token images do not reject the event.
- Token-image fallback renders one bounded grapheme rather than the full symbol.
- The CSS contract clips fallback content inside the 18×18 icon box.

### Integration and release gates

- Run focused parser and card tests through the red-green cycle.
- Run TypeScript type checking and the full Vitest suite.
- Run the production WXT build.
- Manually verify an English Fomo page in the narrow floating window after reloading the unpacked extension.

## Non-goals

- No changes to translation behavior.
- No changes to WebSocket/API capture semantics.
- No fuzzy reconstruction or migration of historical malformed token symbols.
- No external token-image service, cache, or additional host permission.
- No card-height or information-density increase.
