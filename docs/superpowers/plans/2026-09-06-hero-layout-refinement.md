# Hero Layout Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the hero headline to two deliberate desktop lines and separate the sample label from the product preview.

**Architecture:** Add small semantic wrappers to the existing hero markup and style them through the current responsive stylesheet. Preserve mobile wrapping and all existing demo behavior.

**Tech Stack:** Static HTML, CSS, Node.js built-in test runner

---

### Task 1: Add regression coverage

**Files:**
- Modify: `website/homepage.test.mjs`

- [ ] Add assertions for two headline line wrappers and a standalone stage label row.
- [ ] Run `node --test website/homepage.test.mjs` and confirm the new test fails.

### Task 2: Refine hero markup and layout

**Files:**
- Modify: `website/index.html`
- Modify: `website/styles.css`

- [ ] Wrap each intended headline line in `.hero-title-line`.
- [ ] Place `.sample-badge` inside `.stage-label-row` before `.browser-frame`.
- [ ] Add desktop no-wrap rules, stage spacing, and mobile wrapping overrides.
- [ ] Run `node --test website/homepage.test.mjs` and confirm all tests pass.
- [ ] Run `node --check website/main.js` and a CSS brace-balance check.

