# English Fomo DOM Fallback Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct English Fomo DOM recovery events so they retain the real token symbol and token image without allowing fallback content to overlap compact cards.

**Architecture:** Keep WebSocket/API capture authoritative and change only the DOM recovery boundary plus its presentation fallback. Derive the ticker from the normalized activity sentence, extract only a token-link descendant image, pass it through the existing URL normalization policy, and constrain the UI fallback to one grapheme inside its fixed box.

**Tech Stack:** TypeScript, React 19, Vitest, Testing Library, JSDOM, WXT, CSS

---

### Task 1: Lock the English DOM recovery contract

**Files:**
- Modify: `tests/unit/fomo-dom-activity-observer.test.ts`
- Modify: `src/fomo/dom-activity-observer.ts`

- [x] **Step 1: Add a failing English nested-markup regression test**

Add a test whose activity sentence is supplied through the token link `title`, while descendant nodes intentionally concatenate unrelated text in `textContent`:

```ts
it('derives the English ticker from activity text and carries the linked token image', () => {
  document.body.innerHTML = `
    <a href="/tokens/solana/CbcyNo7m1amFWqEQm2m4PLv1UNvpcL3C1UjmExample?tradeId=trade-sol-en-1"
       title="Chino_40 Buy 5m BULL $8.2K at $16.2M MC">
      <img src="/images/tokens/bull.png" alt="BULL">
      <span>Chino_40</span><span>Buy</span><span>BULL</span>
    </a>
  `;

  expect(parseFomoDomActivity(document.querySelector('a')!, 1_800_000)).toMatchObject({
    tradeId: 'trade-sol-en-1',
    type: 'swap_buy',
    userHandle: 'Chino_40',
    ticker: 'BULL',
    tokenImageUrl: '/images/tokens/bull.png',
    usdAmount: 8_200,
    marketCap: 16_200_000,
  });
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
corepack pnpm vitest run tests/unit/fomo-dom-activity-observer.test.ts
```

Expected: FAIL because the current parser prefers concatenated `link.textContent` and does not return `tokenImageUrl`.

- [x] **Step 3: Implement the minimal parser repair**

Extend the recovery candidate and add a token-link-scoped image helper:

```ts
export interface DomActivityCandidate {
  // existing fields
  tokenImageUrl?: string;
}

function findLinkedTokenImageUrl(link: HTMLAnchorElement): string | undefined {
  const value = link.querySelector<HTMLImageElement>('img[src]')
    ?.getAttribute('src')
    ?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}
```

Remove the `link.textContent` preference and derive the ticker only from the normalized activity sentence:

```ts
const beforeFirstMoney = normalizeText(afterTime.split(/\$[0-9]/, 1)[0]);
const tickerCandidate = beforeFirstMoney
  .split(' ')
  .filter((part) => part !== '?')
  .at(-1);
const ticker = (tickerCandidate ?? '').replace(/^\$/, '');
```

Include the scoped image in the returned candidate only when present:

```ts
const tokenImageUrl = findLinkedTokenImageUrl(link);

return {
  // existing fields
  ...(tokenImageUrl === undefined ? {} : { tokenImageUrl }),
};
```

- [x] **Step 4: Run parser tests and verify GREEN**

Run:

```bash
corepack pnpm vitest run tests/unit/fomo-dom-activity-observer.test.ts tests/unit/fomo-normalize.test.ts
```

Expected: all parser and normalization tests pass, including existing Chinese, ARC, thesis, and rejection cases.

### Task 2: Bound the token-image fallback

**Files:**
- Modify: `tests/unit/EventCard.test.tsx`
- Modify: `tests/unit/sidepanel-style-contract.test.ts`
- Modify: `src/overlay/presentation.tsx`
- Modify: `entrypoints/sidepanel/sidepanel.css`

- [x] **Step 1: Add failing presentation tests**

Add a card assertion proving a missing image does not repeat the full ticker:

```ts
it('renders one grapheme inside the token image fallback', () => {
  const { container } = renderCard(makeEvent({
    tokenImageUrl: undefined,
    tokenSymbol: 'BULLISH',
  }));

  expect(container.querySelector('.event-token-fallback')).toHaveTextContent(/^B$/);
  expect(container.querySelector('.event-token-symbol')).toHaveTextContent('$BULLISH');
});
```

Extend the CSS contract test:

```ts
expect(css).toMatch(
  /\.event-token-fallback[^}]*overflow:\s*hidden[^}]*white-space:\s*nowrap/s,
);
```

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```bash
corepack pnpm vitest run tests/unit/EventCard.test.tsx tests/unit/sidepanel-style-contract.test.ts
```

Expected: FAIL because the fallback currently renders the complete ticker and the CSS does not clip it.

- [x] **Step 3: Implement a deterministic grapheme fallback**

Add a focused helper and use it from `TokenImage`:

```ts
export function tokenFallbackFor(symbol: string): string {
  const normalized = symbol.trim();
  if (normalized.length === 0) return '?';

  const first = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    .segment(normalized)
    [Symbol.iterator]()
    .next();
  return first.done ? '?' : first.value.segment;
}
```

```tsx
return <span className={fallbackClassName}>{tokenFallbackFor(symbol)}</span>;
```

Add containment without changing geometry:

```css
.event-token-fallback {
  overflow: hidden;
  white-space: nowrap;
}
```

- [x] **Step 4: Run presentation tests and verify GREEN**

Run:

```bash
corepack pnpm vitest run tests/unit/EventCard.test.tsx tests/unit/sidepanel-style-contract.test.ts
```

Expected: all focused presentation tests pass.

### Task 3: Verify the integrated repair

**Files:**
- Modify only if verification exposes a regression.

- [x] **Step 1: Run TypeScript validation**

Run:

```bash
corepack pnpm typecheck
```

Expected: exit code 0 with no TypeScript diagnostics.

- [x] **Step 2: Run the complete automated suite**

Run:

```bash
corepack pnpm test
```

Expected: all Vitest suites pass with zero failed tests.

- [x] **Step 3: Build the production extension**

Run:

```bash
corepack pnpm build
```

Expected: WXT produces the Chrome MV3 build under `.output/chrome-mv3` with exit code 0.

- [x] **Step 4: Inspect the final diff**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors; only the spec, plan, targeted parser, presentation, CSS, and regression-test files are modified.

- [ ] **Step 5: Manual English-page verification**

Reload the unpacked extension, open the English Fomo feed, and confirm in both side panel and narrow floating window:

- the token image appears when the Fomo token link contains one;
- the token symbol is not prefixed by the trader name or `Buy`/`Sell` text;
- a missing image renders a single bounded fallback character;
- the token symbol, chain badge, amount, and market cap remain aligned;
- Chinese and authoritative-capture events remain unchanged.
