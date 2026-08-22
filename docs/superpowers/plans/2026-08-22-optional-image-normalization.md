# Optional Image Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent optional Fomo avatar and token-image values from rejecting otherwise valid activities.

**Architecture:** Keep core raw activity validation strict while treating image inputs as bounded optional strings. Normalize image values at the raw-to-canonical boundary, resolving root-relative Fomo paths and omitting unsafe or malformed values before persistence.

**Tech Stack:** TypeScript, Zod, Vitest, WXT, React

---

### Task 1: Lock the image-field acceptance contract

**Files:**
- Modify: `tests/unit/fomo-normalize.test.ts`
- Modify: `tests/unit/ingest-activity.test.ts`

- [ ] **Step 1: Add failing normalization tests**

```ts
it('accepts the Fomo default relative avatar and resolves it to HTTPS', async () => {
  const event = await normalizeActivity(
    { ...buyFrame.payload, profilePictureLink: '/fomo-eyes.png' },
    Date.now(),
  );

  expect(event.traderAvatarUrl).toBe('https://fomo.family/fomo-eyes.png');
});

it.each(['', 'http://example.com/avatar.png', 'javascript:alert(1)', 'not a url'])(
  'accepts the trade while omitting unsafe avatar %j',
  async (profilePictureLink) => {
    const event = await normalizeActivity(
      { ...buyFrame.payload, profilePictureLink },
      Date.now(),
    );

    expect(event.traderAvatarUrl).toBeUndefined();
  },
);
```

Add the equivalent invalid `tokenImageUrl` assertion and one ingest test that expects `{ status: 'inserted' }` for `/fomo-eyes.png`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
CI=true corepack pnpm vitest run tests/unit/fomo-normalize.test.ts tests/unit/ingest-activity.test.ts
```

Expected: the relative/default and malformed-image cases fail because `rawActivitySchema` currently rejects them.

### Task 2: Normalize optional images without weakening core fields

**Files:**
- Modify: `src/fomo/raw-schema.ts`
- Modify: `src/fomo/normalize.ts`

- [ ] **Step 1: Make optional raw image fields bounded strings**

Replace URL-semantic validation with bounded input validation:

```ts
const optionalImageInput = z.string().max(MAX_URL_LENGTH).optional();

profilePictureLink: optionalImageInput,
tokenImageUrl: optionalImageInput,
```

- [ ] **Step 2: Add safe canonical image normalization**

```ts
const FOMO_ORIGIN = 'https://fomo.family';

function normalizeOptionalImageUrl(value: string | undefined): string | undefined {
  if (value === undefined || value.trim().length === 0) return undefined;

  try {
    const url = value.startsWith('/')
      ? new URL(value, FOMO_ORIGIN)
      : new URL(value);

    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
```

Use the normalized values when conditionally assigning `traderAvatarUrl` and `tokenImageUrl` to `TradeEventV1`.

- [ ] **Step 3: Run the focused tests and verify GREEN**

Run:

```bash
CI=true corepack pnpm vitest run tests/unit/fomo-normalize.test.ts tests/unit/ingest-activity.test.ts
```

Expected: all focused tests pass; required-field rejection tests remain green.

### Task 3: Verify production boundaries

**Files:**
- Modify only if a regression is discovered by verification.

- [ ] **Step 1: Run the complete gate**

```bash
CI=true corepack pnpm check
```

Expected: typecheck, all Vitest suites, and WXT production build pass.

- [ ] **Step 2: Run real Side Panel E2E**

```bash
CI=true corepack pnpm test:e2e
```

Expected: all Playwright extension tests pass.

- [ ] **Step 3: Reload the unpacked extension and refresh Fomo**

Reload Fomo Live Feed from `chrome://extensions`, refresh the Fomo tab, reopen the Side Panel, and confirm default-avatar activity is visible while the schema-rejection counter no longer increments for it.
