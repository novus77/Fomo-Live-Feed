# BSC and Robinhood Vector Icons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce two transparent, small-size-optimized SVG proposals and a browser comparison without replacing the extension's current chain assets.

**Architecture:** Keep proposed vectors isolated in `icon-proposals/` until visual approval. Validate their static SVG contract with a focused unit test, then use one standalone HTML comparison page to render both vectors at 32, 20, and 16 pixels on light and dark surfaces.

**Tech Stack:** SVG 1.1-compatible markup, Vitest, static HTML/CSS visual preview

---

### Task 1: Add the vector asset contract

**Files:**
- Create: `tests/unit/proposed-chain-icons.test.ts`
- Create: `icon-proposals/bsc.svg`
- Create: `icon-proposals/robinhood.svg`

- [ ] **Step 1: Write the failing static contract test**

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const asset = (name: string) =>
  readFileSync(`icon-proposals/${name}.svg`, 'utf8');

describe('proposed chain icon vectors', () => {
  it.each([
    ['bsc', '#F0B90B'],
    ['robinhood', '#C6FF00'],
  ])('%s is a transparent standalone vector using the approved color', (name, color) => {
    const svg = asset(name);
    expect(svg).toContain('viewBox="0 0 32 32"');
    expect(svg).toContain(color);
    expect(svg).not.toMatch(/<(image|script)\b/i);
    expect(svg).not.toMatch(/<rect[^>]+(?:width="32"|width="100%")/i);
  });
});
```

- [ ] **Step 2: Run the focused test and verify the missing proposals fail**

Run:

```bash
/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/proposed-chain-icons.test.ts
```

Expected: FAIL with `ENOENT` for `icon-proposals/bsc.svg`.

- [ ] **Step 3: Draw both optimized vectors**

Create `icon-proposals/bsc.svg` with a transparent `32 × 32` canvas, one gold compound path, and open negative-space channels matching the supplied cube reference.

Create `icon-proposals/robinhood.svg` with a transparent `32 × 32` canvas and one green compound path preserving the diagonal stem, lower feather, central cut, and rounded upper feather.

- [ ] **Step 4: Verify the vector contract passes**

Run:

```bash
/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/proposed-chain-icons.test.ts
```

Expected: 1 test file and 2 parameterized cases PASS.

- [ ] **Step 5: Commit the vector checkpoint**

```bash
git add icon-proposals/bsc.svg icon-proposals/robinhood.svg tests/unit/proposed-chain-icons.test.ts
git commit -m "design: add replacement chain vectors"
```

### Task 2: Build the visual comparison

**Files:**
- Create: `icon-proposals/preview.html`

- [ ] **Step 1: Create a standalone comparison page**

The page must show the two SVG files in separate cards. Each card renders 32, 20, and 16 pixel samples on `#F7F8FA` and `#090D13`, labels every size, and includes a 200-pixel inspection sample for checking path geometry.

- [ ] **Step 2: Start the visual companion and copy the preview into its screen directory**

Run the visual companion server with the project root, then write a fresh comparison fragment that embeds the same SVG path geometry and provides selectable BSC and Robinhood approval cards.

Expected: the returned local URL displays both vectors on light and dark surfaces.

- [ ] **Step 3: Validate files and keep extension assets unchanged**

Run:

```bash
git diff --check
git diff --quiet -- public/chains/bsc.svg public/chains/robinhood.svg
```

Expected: both commands exit 0; proposed assets remain isolated from production.

- [ ] **Step 4: Commit the preview checkpoint**

```bash
git add icon-proposals/preview.html
git commit -m "design: preview replacement chain vectors"
```
