# Fomo Live Feed Homepage Design Specification

## Goal

Create a focused product homepage that helps a first-time visitor understand Fomo Live Feed in under one minute and install the Chrome extension.

## Audience and primary conversion

The primary audience is a crypto-native browser user who follows Fomo traders but does not yet know the extension. The primary conversion is installing the Chrome extension; secondary actions are learning how the feed works and exploring the product UI.

## Product narrative

The homepage should communicate one simple promise: Fomo Live Feed turns activity from traders followed by the authenticated Fomo user into a live, searchable and filterable Side Panel feed inside Chrome. The story progresses from clarity (what the extension actually does), to proof (a believable current Side Panel surface), to capability (the features already implemented), to action (download and load the extension).

## Page architecture

1. Header: actual extension icon, product name, anchors for Features and How it works, download CTA.
2. Hero: live-status eyebrow, high-contrast headline, accurate explanation, primary download CTA, setup caveat, and a simulated current Side Panel feed.
3. Signal strip: four compact promises — real-time activity while Fomo is open, local searchable history, six-chain visibility, and opinion translation.
4. Feature grid: six implemented capabilities: validated activity capture, local history/search, six chain visibility toggles, optional buy sound, trader annotations and controls, and opinion translation/token navigation/contract copy.
5. Workflow section: log into Fomo and follow traders, keep a Fomo page open, use the Chrome Side Panel.
6. Product proof: a larger mock panel showing the current feed toolbar, semantic event colors, connection state, and event details.
7. Final CTA: direct link to the current v0.3.0 GitHub release ZIP with the real unpacked-extension setup path.
8. Footer: product name, version label, privacy boundary, and lightweight navigation.

## Visual direction

Use the current Side Panel visual language as the source of truth: deep blue-black canvas, raised navy surfaces, thin blue-gray rules, green for buy/connected/live, red for sell, blue for thesis/opinion, and amber for transfer/withdraw. Typography should feel technical but readable: a display sans for headlines and a compact mono face for data labels. Use the repository's actual `public/icons/icon-128.png` in the header and favicon.

Use subtle grid texture, radial glows, and small pulse animations only where they reinforce “live”. Cards should have enough breathing room to avoid feeling like a trading dashboard. The simulated feed is intentionally product-like rather than a generic crypto illustration.

## Interaction and responsive behavior

- Header and hero install buttons link to the current GitHub v0.3.0 ZIP; the URL is isolated in one constant for later replacement by a Chrome Web Store URL.
- Anchor links use native smooth scrolling.
- Feed cards animate in with a gentle stagger on page load; live dots pulse continuously.
- Desktop uses a two-column hero and three-column feature grid.
- At widths below 900px, hero stacks and the mock panel moves below the copy.
- At widths below 620px, navigation links collapse, cards become single column, and all CTA buttons become full-width.
- Reduced-motion users receive the same content with animations disabled.

## Content and accessibility

All visible copy is in Simplified Chinese for the first version, while product labels preserve concise English/crypto terminology where it improves recognition. Buttons are real links or buttons with clear labels, decorative visuals are hidden from assistive technology, and color is never the only indicator of state.

## Scope boundaries

This first version is a static marketing homepage. It does not implement authentication, live API data, an installation backend, analytics, or a documentation system. Product screenshots are built as HTML/CSS mockups so the page remains self-contained and easy to replace with real captures later. The page must not claim cloud sync, monitoring while Fomo is closed, trading/copy-trading, wallet access, production enrichment, or enabled reconnect backfill.

## Validation

- Open `website/index.html` in a browser and inspect desktop and mobile widths.
- Verify all navigation anchors resolve and the install CTA is visually prominent.
- Run the existing extension typecheck/build separately; the website must not alter the WXT entrypoints.

## UI refinement pass

The refinement pass keeps the static, dependency-free architecture but adds the component patterns that are most useful for a product-led Chrome extension homepage:

- A version/status badge in the header to establish release context without inventing user metrics.
- A tabbed product demo with Feed, Chain filters, and Settings states. These states map to the current Side Panel rather than being decorative feature claims.
- Real chain SVG assets in the demo for Base, Ethereum, Solana, BSC, Robinhood, and X Layer.
- More compact status badges, switches, event rows, and local-first notes to make the page feel like a product surface instead of a collection of marketing cards.
- Bento feature cards remain, but their content is limited to current activity capture, local history/search, chain visibility, buy sound, trader annotations, opinion translation, token navigation, and contract copy.

## Third-pass consolidation

The homepage uses a single product-led hero instead of repeating the feed mockup across multiple sections. The hero contains the only interactive preview, with three accessible tabs for the live feed, filters, and settings. Every simulated value is covered by a visible “示例界面” label.

The feature section is consolidated into three asymmetric Bento modules: real-time event types, trader annotations and controls, and reading/navigation tools. The trust strip uses only repository-verifiable facts: open source code, read-only behavior, local persistence, and release checksum availability. The product name is consistently rendered as “Fomo Live Feed,” and download actions explicitly identify the current v0.3.0 ZIP package.
