# Remove Trading-Page Toast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove all trading-page Toast UI and injection while preserving real-time Side Panel activity, history, settings, and support behavior.

**Architecture:** Fomo's MAIN-world interceptor and isolated bridge continue forwarding validated activity to the service worker. The worker persists and broadcasts each event, and Side Panel consumers refresh from IndexedDB; the separate DexScreener/GMGN content-script branch and its toast verdict are removed. Legacy notification/filter fields remain readable storage compatibility data but leave the runtime path.

**Tech Stack:** TypeScript, React, WXT Manifest V3, Zod, Vitest, Testing Library, Playwright, pnpm.

---

## File map

**Delete:**

- `entrypoints/trading-overlay.content/index.ts` — WXT trading-page entrypoint.
- `entrypoints/trading-overlay.content/style.css` — Toast-only Shadow DOM CSS.
- `src/overlay/trading-overlay.ts` — trading-page composition and message listener.
- `src/overlay/ToastStack.tsx` — floating card UI.
- `src/overlay/toast-queue.ts` — Toast lifecycle and visibility queue.
- `tests/unit/ToastStack.test.tsx` — deleted UI tests.
- `tests/unit/toast-queue.test.ts` — deleted queue tests.
- `tests/integration/trading-overlay.test.ts` — deleted integration boundary.

**Modify:**

- `src/messaging/protocol.ts` — activity broadcast becomes `{ event }` only.
- `src/messaging/guards.ts` — remove overlay-specific trust-boundary comments.
- `src/domain/event-validation.ts` — document retained Side Panel validation consumers.
- `src/background/ingest-activity.ts` — remove toast decisions and settings reads.
- `src/background/activity-sync.ts` — remove recovered-toast semantics from comments.
- `entrypoints/background.ts` — remove suppression warm-up calls.
- `wxt.config.ts` — remove trading-page origins and overlay-oriented description.
- `tests/unit/messaging.test.ts` — assert the simplified strict broadcast shape.
- `tests/unit/ingest-activity.test.ts` — remove suppression cases and assert event-only broadcasts.
- `tests/unit/activity-sync.test.ts` — update broadcast fixtures.
- `tests/unit/popup-worker-boundary.test.ts` — update real worker message expectations.
- `tests/unit/manifest-config.test.ts` — lock down the reduced permission/injection surface.
- `tests/e2e/live-feed.spec.ts` — retain live-to-Side-Panel coverage and assert no page injection.
- `tests/e2e/fixtures/trading-page.html` — remove Toast-specific hostile CSS or delete the fixture if no longer needed.
- `README.md`, `docs/development.md`, `docs/manual-testing.zh-CN.md` — Side Panel-only product behavior.
- `scripts/package-local.mjs`, `tests/unit/package-local.test.ts` — offline guide and distribution contract.

Shared modules under `src/overlay/` such as formatting or presentation remain when imported by Side Panel cards.

---

### Task 1: Simplify the activity broadcast protocol

**Files:**
- Modify: `tests/unit/messaging.test.ts`
- Modify: `tests/unit/activity-sync.test.ts`
- Modify: `src/messaging/protocol.ts`

- [ ] **Step 1: Write the failing protocol expectations**

Change the valid broadcast fixture to omit `toast`, and require the old field to
be rejected by the strict schema:

```ts
const valid = parseExtensionMessage({
  protocolVersion: 1,
  type: 'activity.broadcast',
  payload: { event },
});
expect(valid.ok).toBe(true);

const legacyToastPayload = parseExtensionMessage({
  protocolVersion: 1,
  type: 'activity.broadcast',
  payload: { event, toast: true },
});
expect(legacyToastPayload.ok).toBe(false);
```

Update `tests/unit/activity-sync.test.ts` broadcast fixtures from
`payload: { event, toast: true }` to `payload: { event }`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
CI=true corepack pnpm vitest run tests/unit/messaging.test.ts tests/unit/activity-sync.test.ts
```

Expected: messaging tests fail because `toast` is currently required; TypeScript
fixtures may also fail against the old inferred message type.

- [ ] **Step 3: Implement the event-only protocol**

Replace the payload schema with:

```ts
const activityBroadcastPayloadSchema = z
  .object({
    event: unknownPayloadSchema,
  })
  .strict();
```

Update the nearby comments and `ActivityBroadcastMessage` documentation to say
the event is broadcast to extension consumers after persistence. Remove all
references to an overlay or suppression verdict.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the command from Step 2.

Expected: both test files pass with no type errors from broadcast fixtures.

- [ ] **Step 5: Commit**

```bash
git add src/messaging/protocol.ts tests/unit/messaging.test.ts tests/unit/activity-sync.test.ts
git commit -m "refactor: simplify activity broadcasts"
```

### Task 2: Remove toast suppression from event ingestion

**Files:**
- Modify: `tests/unit/ingest-activity.test.ts`
- Modify: `tests/unit/popup-worker-boundary.test.ts`
- Modify: `src/background/ingest-activity.ts`
- Modify: `src/background/activity-sync.ts`
- Modify: `entrypoints/background.ts`

- [ ] **Step 1: Rewrite ingestion tests around the retained contract**

For live and recovered events, assert:

```ts
expect(broadcast.messages[0]).toEqual({
  protocolVersion: 1,
  type: 'activity.broadcast',
  payload: { event: expectedEvent },
});
```

Remove imports and test blocks for `shouldToast`, `ToastSuppressionCache`,
`warmSuppression`, muted traders, muted chains, minimum amount suppression, and
failed preference refreshes. Update real-worker fixtures in
`popup-worker-boundary.test.ts` to use `payload: { event }`.

- [ ] **Step 2: Run the ingestion/boundary tests and verify RED**

Run:

```bash
CI=true corepack pnpm vitest run tests/unit/ingest-activity.test.ts tests/unit/popup-worker-boundary.test.ts
```

Expected: failures show the worker still emits `toast` and exposes suppression
APIs that the new contract no longer expects.

- [ ] **Step 3: Remove suppression dependencies and code**

In `ActivityIngestDependencies`, delete `preferences`. Delete `shouldToast`,
`ToastSuppressionCache`, the `suppression` field, `warmSuppression()`, the
boolean argument passed into the shared insert tail, and the background refresh.
The broadcast becomes:

```ts
await this.deps.broadcast({
  protocolVersion: 1,
  type: 'activity.broadcast',
  payload: { event },
});
```

Both `ingest()` and `ingestRecovered()` call the same event-only tail. In
`entrypoints/background.ts`, remove the two `warmSuppression()` calls and stop
passing preference readers solely used by suppression. Update recovery comments
in `src/background/activity-sync.ts`.

- [ ] **Step 4: Remove stale boundary comments**

Update `src/messaging/guards.ts` and `src/domain/event-validation.ts` so their
consumer lists mention the worker and Side Panel/history boundaries, not
`src/overlay/trading-overlay.ts`.

- [ ] **Step 5: Run focused tests and typecheck**

Run:

```bash
CI=true corepack pnpm vitest run tests/unit/ingest-activity.test.ts tests/unit/popup-worker-boundary.test.ts tests/unit/activity-sync.test.ts
CI=true corepack pnpm typecheck
```

Expected: focused tests pass and `tsc --noEmit` reports no errors.

- [ ] **Step 6: Commit**

```bash
git add entrypoints/background.ts src/background/ingest-activity.ts src/background/activity-sync.ts src/messaging/guards.ts src/domain/event-validation.ts tests/unit/ingest-activity.test.ts tests/unit/popup-worker-boundary.test.ts
git commit -m "refactor: remove toast suppression pipeline"
```

### Task 3: Remove trading-page injection and reduce permissions

**Files:**
- Modify: `tests/unit/manifest-config.test.ts`
- Modify: `wxt.config.ts`
- Delete: `entrypoints/trading-overlay.content/index.ts`
- Delete: `entrypoints/trading-overlay.content/style.css`
- Delete: `src/overlay/trading-overlay.ts`
- Delete: `src/overlay/ToastStack.tsx`
- Delete: `src/overlay/toast-queue.ts`
- Delete: `tests/unit/ToastStack.test.tsx`
- Delete: `tests/unit/toast-queue.test.ts`
- Delete: `tests/integration/trading-overlay.test.ts`

- [ ] **Step 1: Add failing source and manifest assertions**

Extend `manifest-config.test.ts` with:

```ts
expect(manifest.host_permissions).not.toContain('https://dexscreener.com/*');
expect(manifest.host_permissions).not.toContain('https://gmgn.ai/*');

expect(existsSync(resolve('entrypoints/trading-overlay.content'))).toBe(false);
```

Also assert that a production build's `manifest.json` has no content script
whose `matches` contain either trading origin.

- [ ] **Step 2: Run the manifest test and verify RED**

Run:

```bash
CI=true corepack pnpm vitest run tests/unit/manifest-config.test.ts
```

Expected: the permission and entrypoint-absence assertions fail.

- [ ] **Step 3: Remove the injection surface**

Delete the Toast-only files listed above. In `wxt.config.ts`, retain only:

```ts
host_permissions: [
  'https://fomo.family/*',
  'https://www.fomo.family/*',
  'https://translate.googleapis.com/*',
],
```

Change the description to:

```ts
description: 'Show real-time activity from followed Fomo traders in Chrome Side Panel.',
```

- [ ] **Step 4: Build and verify the generated manifest**

Run:

```bash
CI=true corepack pnpm build
CI=true corepack pnpm vitest run tests/unit/manifest-config.test.ts
rg -n "trading-overlay|dexscreener|gmgn" .output/chrome-mv3/manifest.json .output/chrome-mv3
```

Expected: build and test pass; `rg` produces no matches.

- [ ] **Step 5: Verify retained shared modules have consumers**

Run:

```bash
rg -n "from '../overlay|from '../../src/overlay|from './overlay" src entrypoints tests
```

Expected: retained formatting/presentation imports belong to Side Panel code;
there are no imports of deleted Toast modules.

- [ ] **Step 6: Commit**

```bash
git add wxt.config.ts tests/unit/manifest-config.test.ts entrypoints src/overlay tests/unit tests/integration
git commit -m "feat: remove trading page toast overlay"
```

### Task 4: Refactor end-to-end coverage for Side Panel-only delivery

**Files:**
- Modify: `tests/e2e/live-feed.spec.ts`
- Modify or delete: `tests/e2e/fixtures/trading-page.html`

- [ ] **Step 1: Replace Toast assertions with a no-injection assertion**

Keep the existing authenticated Fomo fixture, live WebSocket frame, and Side
Panel setup. Replace the first live-flow test's Toast barrier with a Side Panel
history assertion, then assert on a representative trading page:

```ts
await expect(sidePanel.getByText('$FOMO')).toBeVisible();

await tradingPage.goto(fixtureUrl('/trading-page.html'));
await expect(
  tradingPage.locator('#fomo-live-feed-toast-host'),
).toHaveCount(0);
```

Remove CDP closed-shadow helpers and tests for card limit, dismissal, hover,
host CSS isolation, or duplicate Toasts. Preserve E2E cases for persistence,
deduplication, reconnect behavior, diagnostics, and Side Panel presentation.

- [ ] **Step 2: Run E2E and verify the old suite is RED before cleanup**

Run:

```bash
CI=true corepack pnpm test:e2e
```

Expected: old Toast waits fail because the content script no longer creates a
host; the newly retained Side Panel assertions identify the intended path.

- [ ] **Step 3: Complete the E2E cleanup**

Delete unused Toast-specific types, CDP helpers, selectors, and hostile CSS from
the fixture. Keep only helpers used by retained Fomo, worker, and Side Panel
tests. Rename the primary test to:

```ts
test('delivers live activity to searchable Side Panel history and diagnostics', async () => {
```

- [ ] **Step 4: Run E2E and verify GREEN**

Run:

```bash
CI=true corepack pnpm test:e2e
```

Expected: every remaining Playwright test passes; no test waits for a Toast host.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/live-feed.spec.ts tests/e2e/fixtures/trading-page.html
git commit -m "test: cover side panel only delivery"
```

### Task 5: Update user documentation and local distribution guidance

**Files:**
- Modify: `tests/unit/package-local.test.ts`
- Modify: `scripts/package-local.mjs`
- Modify: `README.md`
- Modify: `docs/development.md`
- Modify: `docs/manual-testing.zh-CN.md`

- [ ] **Step 1: Add failing distribution-document assertions**

Require the offline guide to describe Side Panel-only behavior and omit Toast
instructions:

```ts
expect(guide).toContain('Side Panel');
expect(guide).toContain('右侧信息流');
expect(guide).not.toMatch(/Toast|交易页面显示/);
```

Add README/document checks that reject `trading-overlay`, `toast stack`, and the
old DexScreener/GMGN host-permission description.

- [ ] **Step 2: Run the package test and verify RED**

Run:

```bash
CI=true corepack pnpm vitest run tests/unit/package-local.test.ts
```

Expected: the current guide still promises trading-page Toasts.

- [ ] **Step 3: Update the offline guide**

In `renderGuide()`, describe the startup result as:

```html
<li>点击 Chrome 工具栏里的 Fomo Live Feed 图标，打开右侧 Side Panel 信息流。</li>
<li>关注交易员的新动态会实时进入 Side Panel；插件不会在交易页面额外弹出通知卡片。</li>
```

- [ ] **Step 4: Update repository documentation**

Rewrite README architecture and feature bullets around Side Panel-only delivery.
Remove trading-overlay paths and permissions from `docs/development.md`. Update
the Chinese manual checklist to assert that DexScreener/GMGN contain no floating
card and the Side Panel still receives the event.

- [ ] **Step 5: Run documentation/package tests and verify GREEN**

Run:

```bash
CI=true corepack pnpm vitest run tests/unit/package-local.test.ts tests/unit/manifest-config.test.ts
rg -n "toast stack|trading-overlay|交易页面显示 Toast" README.md docs/development.md docs/manual-testing.zh-CN.md scripts/package-local.mjs
```

Expected: tests pass and `rg` produces no stale product claims.

- [ ] **Step 6: Commit**

```bash
git add README.md docs/development.md docs/manual-testing.zh-CN.md scripts/package-local.mjs tests/unit/package-local.test.ts
git commit -m "docs: describe side panel only activity"
```

### Task 6: Run the complete release gate and regenerate the ZIP

**Files:**
- Generated, ignored: `.output/chrome-mv3/`
- Generated, ignored: `.output/releases/Fomo-Live-Feed-v0.1.0-chrome.zip`
- Generated, ignored: `.output/releases/Fomo-Live-Feed-v0.1.0-chrome.zip.sha256`

- [ ] **Step 1: Scan the source tree for stale runtime references**

Run:

```bash
rg -n "trading-overlay|ToastStack|toast-queue|payload\.toast|warmSuppression|shouldToast" entrypoints src tests README.md docs/development.md docs/manual-testing.zh-CN.md
```

Expected: no runtime or current-product references. Historical design/evidence
documents outside this command's explicit list may retain historical context.

- [ ] **Step 2: Run the complete static/unit/build gate**

Run:

```bash
CI=true corepack pnpm check
```

Expected: typecheck, all Vitest files, and WXT production build pass.

- [ ] **Step 3: Run the complete browser E2E gate**

Run:

```bash
CI=true corepack pnpm test:e2e
```

Expected: all retained Playwright tests pass.

- [ ] **Step 4: Generate the final local-distribution artifact**

Run:

```bash
CI=true corepack pnpm package:local
```

Expected: the versioned ZIP and neighboring SHA-256 file are generated under
`.output/releases/` after a fresh test/build pass.

- [ ] **Step 5: Validate the artifact as a recipient would receive it**

Run from `.output/releases/`:

```bash
shasum -a 256 -c Fomo-Live-Feed-v0.1.0-chrome.zip.sha256
unzip -Z1 Fomo-Live-Feed-v0.1.0-chrome.zip
unzip -p Fomo-Live-Feed-v0.1.0-chrome.zip manifest.json
```

Expected: checksum reports `OK`; `manifest.json` and `START-HERE.html` are at
the archive root; there is no `content-scripts/trading-overlay.js`; the manifest
contains no DexScreener/GMGN match or host permission.

- [ ] **Step 6: Review repository state**

Run:

```bash
git diff --check
git status --short
git log --oneline --decorate -8
```

Expected: no whitespace errors, no accidental generated files, and all planned
implementation commits are present on `codex/remove-trading-toast`.

---

## Final acceptance checklist

- [ ] No trading-page content script is built or declared.
- [ ] DexScreener and GMGN host permissions are absent.
- [ ] Activity broadcasts and ingestion contain no Toast verdict.
- [ ] Side Panel receives, persists, searches, and renders new activity.
- [ ] Trading pages receive no Fomo Toast host element.
- [ ] Existing settings/support behavior remains intact.
- [ ] Current docs and offline guide describe Side Panel-only behavior.
- [ ] Full checks, E2E, ZIP inspection, and checksum validation pass.
