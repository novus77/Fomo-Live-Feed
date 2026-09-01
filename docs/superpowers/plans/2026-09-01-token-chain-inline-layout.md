# Token and Chain Inline Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the artificial gap between the token image and symbol, then keep the chain badge immediately after the symbol without increasing event-card height.

**Architecture:** Preserve the existing EventCard markup and three-column action row. Correct only the token identity flex contract: the symbol becomes content-sized and left-aligned while retaining shrink/ellipsis behavior under constrained width.

**Tech Stack:** CSS Flexbox, Vitest static style contracts, React Testing Library, Playwright

---

### Task 1: Lock and correct the inline token layout

**Files:**
- Modify: `tests/unit/sidepanel-style-contract.test.ts`
- Modify: `entrypoints/sidepanel/sidepanel.css`

- [ ] **Step 1: Write the failing CSS contract test**

Add assertions that `.event-token-symbol` contains `flex: 0 1 auto` and that `.event-token-link` contains `text-align: left`.

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/sidepanel-style-contract.test.ts
```

Expected: FAIL because `.event-token-symbol` still contains `flex: 1` and the link has no explicit left alignment.

- [ ] **Step 3: Implement the minimal CSS correction**

Use this sizing contract:

```css
.event-token-symbol {
  min-width: 0;
  overflow: hidden;
  flex: 0 1 auto;
  font-weight: 600;
  text-overflow: ellipsis;
}

.event-token-link {
  text-align: left;
}
```

Keep the existing `.event-token-identity` gap and row grid unchanged.

- [ ] **Step 4: Run focused component and style tests**

Run:

```bash
/usr/local/bin/node node_modules/vitest/vitest.mjs run tests/unit/sidepanel-style-contract.test.ts tests/unit/EventCard.test.tsx tests/unit/ChainBadge.test.tsx
```

Expected: all focused tests PASS.

- [ ] **Step 5: Run density and build verification**

Run:

```bash
/usr/local/bin/node node_modules/typescript/bin/tsc --noEmit
/usr/local/bin/node node_modules/wxt/bin/wxt.mjs build
/usr/local/bin/node node_modules/@playwright/test/cli.js test tests/e2e/live-feed.spec.ts
```

Expected: typecheck and build exit 0; all 13 browser scenarios PASS, including the side-panel density assertion.

- [ ] **Step 6: Commit the layout checkpoint**

```bash
git add entrypoints/sidepanel/sidepanel.css tests/unit/sidepanel-style-contract.test.ts
git commit -m "fix: keep token chain identity compact"
```
