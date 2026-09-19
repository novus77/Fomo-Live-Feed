# Fomo Live Feed Homepage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a self-contained dark product homepage that explains Fomo Live Feed and drives Chrome extension installation.

**Architecture:** Add a static `website/` surface independent from the existing WXT extension entrypoints. Keep semantic content in `index.html`, visual tokens and responsive layout in `styles.css`, and small interaction behavior in `main.js`.

**Tech Stack:** HTML, CSS, vanilla JavaScript, Google Fonts CDN with system fallbacks.

---

### Task 1: Add the homepage document

**Files:**
- Create: `website/index.html`

- [ ] Add semantic sections for header, hero, signal strip, features, workflow, product proof, final CTA, and footer.
- [ ] Use the existing extension capabilities as the feature copy and build the feed preview with accessible labels.

### Task 2: Add visual system and responsive layout

**Files:**
- Create: `website/styles.css`

- [ ] Define dark palette, grid texture, typography, cards, buttons, feed rows, and responsive breakpoints from the design specification.
- [ ] Add reduced-motion handling and maintain visible focus styles.

### Task 3: Add lightweight interactions

**Files:**
- Create: `website/main.js`

- [ ] Keep the Chrome install destination in one constant and wire install links.
- [ ] Add IntersectionObserver reveal behavior with a reduced-motion fallback.

### Task 4: Verify the result

**Files:**
- Verify: `website/index.html`
- Verify: `website/styles.css`
- Verify: `website/main.js`

- [ ] Open the static page locally and verify anchor navigation, responsive layout, and CTA states.
- [ ] Run `pnpm typecheck` and `pnpm build` to confirm the extension build remains unaffected.
