# BSC and Robinhood Vector Icon Design

## Scope

Create two replacement-ready SVG assets from the user-provided references. This phase produces and previews the vectors only; integration into the extension remains a separate confirmation step.

## Visual Direction

- Use a transparent background for both icons.
- Use a shared `0 0 32 32` view box and no embedded raster data, text, scripts, or external resources.
- Optimize paths for legibility at 16, 20, and 32 CSS pixels rather than tracing every raster edge.

### BSC

- Reproduce the gold open-cube mark from the supplied reference.
- Preserve the isometric top diamond, central cube, and symmetric lower side walls.
- Use brand gold `#F0B90B` with slightly reinforced negative-space channels at small sizes.

### Robinhood

- Keep only the feather silhouette from the supplied reference.
- Remove the neon square background and recolor the feather to Robinhood green `#C6FF00`.
- Preserve the diagonal stem, two feather masses, central cut, and upper-right rounded silhouette.

## Validation

Present each SVG at 32, 20, and 16 pixels on both dark and light surfaces. Confirm that the BSC internal channels stay open and the Robinhood feather remains recognizable before replacing the existing extension assets.
