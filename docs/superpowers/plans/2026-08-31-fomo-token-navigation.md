# Fomo Token Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make only the token identity reuse and activate the preferred Fomo tab at a verified token page, with safe new-tab fallback.

**Architecture:** The card sends chain and contract address through a closed privileged-UI message; the service worker rebuilds the fixed-origin URL, ranks Fomo tabs deterministically, and updates or creates the target tab. Verified route slugs are `solana`, `robinhood`, `bnb` for project chain `bsc`, and `base`; `ethereum`, `x-layer`, and `unknown` remain non-interactive without route evidence.

**Tech Stack:** TypeScript, React, WXT WebExtension APIs, Zod, Vitest, Testing Library, Playwright

---

## File map

- Create `docs/evidence/fomo-token-navigation-contract.md`: observed route evidence and closed chain-slug mapping.
- Modify `src/navigation/fomo-links.ts`: replace provisional route with verified `/tokens/` mapping.
- Create `src/background/fomo-tab-navigation.ts`: pure tab ranking and update/create workflow.
- Modify `src/messaging/protocol.ts` and `src/messaging/guards.ts`: closed privileged-UI navigation request.
- Modify `entrypoints/background.ts`: validate sender and execute navigation.
- Modify `src/popup/EventCard.tsx`: remove card-level click and make only token identity interactive.
- Modify `src/sidepanel/SidePanelApp.tsx` and `entrypoints/sidepanel/App.tsx`: send navigation request instead of `window.open`.
- Modify `entrypoints/sidepanel/sidepanel.css`: explicit token link affordance without enlarging cards.
- Test `tests/unit/navigation.test.ts`, `tests/unit/fomo-tab-navigation.test.ts`, `tests/unit/messaging.test.ts`, `tests/unit/EventCard.test.tsx`, `tests/unit/SidePanelApp.test.tsx`, `tests/unit/popup-worker-boundary.test.ts`, and `tests/e2e/live-feed.spec.ts`.

### Task 1: Record and lock the real Fomo route contract

**Files:**
- Create: `docs/evidence/fomo-token-navigation-contract.md`
- Modify: `src/navigation/fomo-links.ts`
- Test: `tests/unit/navigation.test.ts`

- [ ] **Step 1: Write the evidence document**

Record the 2026-08-31 authenticated-browser observations:

```text
https://fomo.family/tokens/solana/{solanaAddress}
https://fomo.family/tokens/robinhood/{evmAddress}
https://fomo.family/tokens/bnb/{evmAddress}
https://fomo.family/tokens/base/{evmAddress}
```

Document mapping `solana -> solana`, `robinhood -> robinhood`, `bsc -> bnb`, and `base -> base`. State explicitly that `ethereum`, `x-layer`, and `unknown` return no navigation target because no current Fomo token-route evidence was observed. Include the official Base support reference `https://fomo.family/blog/september-2025-recap`.

- [ ] **Step 2: Replace provisional URL tests with failing verified-route tests**

Assert exact paths:

```ts
expect(buildFomoTokenUrl('bsc', EVM_ADDRESS)?.pathname)
  .toBe('/tokens/bnb/' + EVM_ADDRESS);
expect(buildFomoTokenUrl('base', EVM_ADDRESS)?.pathname)
  .toBe('/tokens/base/' + EVM_ADDRESS);
expect(buildFomoTokenUrl('solana', SOLANA_ADDRESS)?.pathname)
  .toBe('/tokens/solana/' + SOLANA_ADDRESS);
expect(buildFomoTokenUrl('robinhood', EVM_ADDRESS)?.pathname)
  .toBe('/tokens/robinhood/' + EVM_ADDRESS);
expect(buildFomoTokenUrl('ethereum', EVM_ADDRESS)).toBeNull();
expect(buildFomoTokenUrl('x-layer', EVM_ADDRESS)).toBeNull();
expect(buildFomoTokenUrl('unknown', EVM_ADDRESS)).toBeNull();
```

- [ ] **Step 3: Run the test and confirm failure**

```bash
corepack pnpm vitest run tests/unit/navigation.test.ts
```

Expected: FAIL because the builder still emits `/token/{projectChain}/...`.

- [ ] **Step 4: Implement the closed slug map**

Replace `TOKEN_PATH` and direct chain interpolation with:

```ts
const TOKEN_PATH = '/tokens/';
const FOMO_TOKEN_CHAIN = {
  bsc: 'bnb',
  solana: 'solana',
  robinhood: 'robinhood',
  base: 'base',
} as const;

type NavigableChain = keyof typeof FOMO_TOKEN_CHAIN;
```

After address validation, return `null` unless `chain in FOMO_TOKEN_CHAIN`; otherwise use the mapped slug and canonical address. Keep the fixed HTTPS origin invariant.

- [ ] **Step 5: Re-run the test**

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add docs/evidence/fomo-token-navigation-contract.md src/navigation/fomo-links.ts tests/unit/navigation.test.ts
git commit -m "fix: lock verified fomo token routes"
```

### Task 2: Add the privileged navigation message

**Files:**
- Modify: `src/messaging/protocol.ts`
- Modify: `src/messaging/guards.ts`
- Test: `tests/unit/messaging.test.ts`

- [ ] **Step 1: Write failing message tests**

Test this exact request:

```ts
const message = {
  protocolVersion: 1,
  type: 'navigation.openToken',
  payload: { chain: 'bsc', tokenAddress: EVM_ADDRESS },
};
expect(parseExtensionMessage(message)).toMatchObject({ ok: true });
expect(trustClassForMessageType('navigation.openToken'))
  .toBe('privileged-ui-page');
```

Reject unknown chain, blank/over-256 address, extra keys, web-tab sender, and other-extension sender.

- [ ] **Step 2: Run the test and confirm failure**

```bash
corepack pnpm vitest run tests/unit/messaging.test.ts
```

- [ ] **Step 3: Implement the strict payload**

Add:

```ts
const openTokenPayloadSchema = z.object({
  chain: z.enum(CHAIN_KEYS),
  tokenAddress: trimmedBoundedString(MAX_TOKEN_ADDRESS_LENGTH),
}).strict();
```

Add the `navigation.openToken` branch to `extensionMessageSchema` and map it to `privileged-ui-page` in the sender guard.

- [ ] **Step 4: Re-run tests and commit**

```bash
corepack pnpm vitest run tests/unit/messaging.test.ts
git add src/messaging/protocol.ts src/messaging/guards.ts tests/unit/messaging.test.ts
git commit -m "feat: add token navigation message"
```

### Task 3: Implement deterministic Fomo tab reuse

**Files:**
- Create: `src/background/fomo-tab-navigation.ts`
- Test: `tests/unit/fomo-tab-navigation.test.ts`

- [ ] **Step 1: Write failing ranking tests**

Use this narrow type:

```ts
export interface FomoTabCandidate {
  id?: number;
  windowId: number;
  lastAccessed?: number;
}
```

Assert `selectFomoTab(tabs, currentWindowId)` chooses the greatest `lastAccessed` in the current window first, then greatest across other windows, ignores entries without `id`, and returns `undefined` for none. Treat missing `lastAccessed` as `0` and use ascending `id` as the deterministic tie-breaker.

- [ ] **Step 2: Write failing navigation workflow tests**

Define injected APIs:

```ts
export interface TokenNavigationChrome {
  tabs: {
    query(query: { url: string[] }): Promise<FomoTabCandidate[]>;
    update(tabId: number, update: { url: string; active: true }): Promise<unknown>;
    create(create: { url: string; active: true }): Promise<unknown>;
  };
  windows: {
    getLastFocused(): Promise<{ id?: number }>;
    update(windowId: number, update: { focused: true }): Promise<unknown>;
  };
}
```

Assert existing-tab success calls `tabs.update` and `windows.update`; no tab calls `tabs.create`; update rejection calls `tabs.create` exactly once; invalid builder result performs no Chrome call and returns `{ ok: false, reason: 'invalid-target' }`.

- [ ] **Step 3: Run and confirm failure**

```bash
corepack pnpm vitest run tests/unit/fomo-tab-navigation.test.ts
```

- [ ] **Step 4: Implement ranking and workflow**

Export `selectFomoTab` and `openFomoToken`. Query only:

```ts
['https://fomo.family/*', 'https://www.fomo.family/*']
```

Build the URL before querying. Update with `{ url: target.href, active: true }`, focus the selected window, and fall back to `{ url: target.href, active: true }` creation only when no candidate exists or update fails. Catch final failure and return `{ ok: false, reason: 'chrome-api-failed' }` without throwing.

- [ ] **Step 5: Re-run and commit**

```bash
corepack pnpm vitest run tests/unit/fomo-tab-navigation.test.ts
git add src/background/fomo-tab-navigation.ts tests/unit/fomo-tab-navigation.test.ts
git commit -m "feat: reuse fomo token tabs"
```

### Task 4: Wire navigation through the service worker

**Files:**
- Modify: `entrypoints/background.ts`
- Modify: `src/background/diagnostics.ts`
- Test: `tests/unit/popup-worker-boundary.test.ts`

- [ ] **Step 1: Write failing boundary tests**

Send `navigation.openToken` from a trusted extension page and assert the injected tabs API updates the selected Fomo tab. Assert a Fomo web sender and other-extension sender are rejected before tab calls. Assert invalid address returns `{ ok: false }` and a Chrome failure records only `token_navigation_failure` with message type `navigation.openToken`.

- [ ] **Step 2: Run the boundary test and confirm failure**

```bash
corepack pnpm vitest run tests/unit/popup-worker-boundary.test.ts
```

- [ ] **Step 3: Add the handler**

Compose `openFomoToken` with browser tabs/windows. Add this switch branch after sender validation:

```ts
case 'navigation.openToken':
  return openToken(message.payload).then((result) => {
    if (!result.ok && result.reason === 'chrome-api-failed') {
      diagnostics.record({
        code: 'token_navigation_failure',
        messageType: 'navigation.openToken',
      });
    }
    return result;
  });
```

Add only the closed diagnostic code; never record chain, address, or URL.

- [ ] **Step 4: Re-run and commit**

```bash
corepack pnpm vitest run tests/unit/popup-worker-boundary.test.ts
git add entrypoints/background.ts src/background/diagnostics.ts tests/unit/popup-worker-boundary.test.ts
git commit -m "feat: handle fomo token navigation"
```

### Task 5: Make only the token identity interactive

**Files:**
- Modify: `src/popup/EventCard.tsx`
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `entrypoints/sidepanel/App.tsx`
- Modify: `entrypoints/sidepanel/sidepanel.css`
- Test: `tests/unit/EventCard.test.tsx`
- Test: `tests/unit/SidePanelApp.test.tsx`

- [ ] **Step 1: Write failing Event Card tests**

Assert clicking the article/card whitespace does not call navigation. Assert clicking `$TOKEN` calls:

```ts
onOpenToken({ chain: event.chain, tokenAddress: event.tokenAddress });
```

Assert profile click retains its profile target, copy calls only `copyText`, and `ethereum`, `x-layer`, `unknown`, or invalid addresses render `$TOKEN` as non-interactive text.

- [ ] **Step 2: Run focused UI tests and confirm failure**

```bash
corepack pnpm vitest run tests/unit/EventCard.test.tsx tests/unit/SidePanelApp.test.tsx
```

- [ ] **Step 3: Replace the card-level handler**

Remove `onClick={handleCardClick}` from `<article>`. Replace the token symbol span with a button only when `buildFomoTokenUrl(...) !== null`:

```tsx
<button
  type="button"
  className="event-token-link"
  onClick={(mouseEvent) => {
    mouseEvent.stopPropagation();
    onOpenToken({ chain: event.chain, tokenAddress: event.tokenAddress });
  }}
>
  ${event.tokenSymbol}
</button>
```

Otherwise render the existing non-button span. Change the prop from generic `openLink` token behavior to a typed `onOpenToken`, while retaining profile navigation independently.

- [ ] **Step 4: Wire Side Panel runtime messaging**

Pass a callback that calls:

```ts
runtime.sendMessage({
  protocolVersion: 1,
  type: 'navigation.openToken',
  payload: target,
});
```

Terminate with `.catch(() => {})`; the service worker owns fallback and diagnostics. Keep `openLink` only for the trader profile.

- [ ] **Step 5: Add compact link styling**

Make `.event-token-link` inherit font/color, remove native border/background/padding, use `cursor: pointer`, and add underline only on hover/focus-visible. Do not change line height or card spacing.

- [ ] **Step 6: Re-run and commit**

```bash
corepack pnpm vitest run tests/unit/EventCard.test.tsx tests/unit/SidePanelApp.test.tsx
git add src/popup/EventCard.tsx src/sidepanel/SidePanelApp.tsx entrypoints/sidepanel/App.tsx entrypoints/sidepanel/sidepanel.css tests/unit/EventCard.test.tsx tests/unit/SidePanelApp.test.tsx
git commit -m "feat: navigate from token identity only"
```

### Task 6: End-to-end and release validation

**Files:**
- Modify: `tests/e2e/live-feed.spec.ts`
- Modify: `docs/manual-testing.zh-CN.md`

- [ ] **Step 1: Add E2E cases**

Open one authenticated fixture Fomo tab and the Side Panel. Click a BSC token identity and assert that exact tab becomes active at `/tokens/bnb/{canonicalAddress}` and total Fomo-tab count stays one. Close it, click again, and assert exactly one new Fomo tab opens. Click card whitespace and assert no URL or tab-count change.

- [ ] **Step 2: Run focused E2E**

```bash
corepack pnpm playwright test tests/e2e/live-feed.spec.ts --grep "token navigation"
```

Expected: PASS.

- [ ] **Step 3: Add manual checks**

Document checks for Solana, BNB, Robinhood, and Base routes; confirm Ethereum/X Layer/unknown remain plain text; confirm username, CA copy, translation, and card whitespace do not trigger token navigation.

- [ ] **Step 4: Run the full release gate**

```bash
corepack pnpm exec tsc --noEmit
corepack pnpm vitest run
corepack pnpm playwright test
corepack pnpm build
corepack pnpm package:local
```

Expected: all commands PASS and the generated package preserves only the existing Fomo/translation host permissions.

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/live-feed.spec.ts docs/manual-testing.zh-CN.md
git commit -m "test: validate fomo token navigation"
```
