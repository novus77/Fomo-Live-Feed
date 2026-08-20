# Fomo Live Feed Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Chrome Manifest V3 extension that relays authenticated Fomo social-trading activity into a three-card in-page toast stack and a locally persisted toolbar history popup.

**Architecture:** WXT provides typed Manifest V3 entrypoints. A main-world Fomo interceptor forwards candidate WebSocket frames to an isolated content bridge, which validates and sends them to a service worker. The worker normalizes, deduplicates, enriches, persists, and broadcasts events; Dexie owns event history, while versioned `chrome.storage.local` records own settings and trader annotations.

**Tech Stack:** WXT 0.21.x, React 19, TypeScript 5.x, Zod 4, Dexie 4, Vitest 3+, Testing Library, Playwright, pnpm, Chrome Manifest V3.

---

## Scope and implementation assumptions

- Initial supported overlay sites are DexScreener (`https://dexscreener.com/*`) and GMGN (`https://gmgn.ai/*`). Add further platforms through the centralized host catalog, never `<all_urls>`.
- Fomo collection runs only on `https://fomo.family/*` and `https://www.fomo.family/*`.
- The WebSocket contract is internal and unstable. Runtime validation and observable rejection are release requirements.
- Fomo enrichment endpoints must be captured from authenticated browser traffic before an endpoint is promoted from an adapter fixture into production code. Lifetime statistics must never be presented as 7-day statistics.
- The MVP does not contain a backend, cloud sync, Side Panel, trading, or wallet code.

## Planned file structure

```text
entrypoints/
  background.ts                       Service-worker composition root
  fomo-interceptor.content.ts         MAIN-world WebSocket observer
  fomo-bridge.content.ts              ISOLATED-world validation bridge
  trading-overlay.content/
    index.ts                          Overlay mount and runtime messages
    style.css                         Shadow-DOM toast styles
  popup/
    index.html
    main.tsx
    App.tsx                           Popup composition root
    popup.css
src/
  domain/
    activity.ts                       Canonical event and metric types
    annotations.ts                    Sync-ready annotation types
    settings.ts                       Settings model and defaults
  fomo/
    raw-schema.ts                     Zod schemas for intercepted frames
    normalize.ts                      Raw-to-canonical normalization
    network-map.ts                    Fomo network ID mapping
    enrichment-client.ts              Authenticated metric adapter
  messaging/
    protocol.ts                       Versioned cross-context messages
    guards.ts                         Sender/origin validation
  storage/
    database.ts                       Dexie schema and migrations
    event-repository.ts               Event persistence and queries
    metric-repository.ts              Metric cache
    local-preferences.ts              chrome.storage.local adapter
  background/
    ingest-activity.ts                Ingest use case
    connection-state.ts               Connected/offline state
    badge.ts                          Unread badge projection
    retention.ts                      Bounded cleanup
  overlay/
    toast-queue.ts                    Pure three-card queue state
    ToastStack.tsx                    Toast rendering
  popup/
    event-query.ts                    Popup query model
    use-event-feed.ts                 Paginated feed hook
    HistoryFeed.tsx
    EventCard.tsx
    FilterBar.tsx
    TraderAnnotationEditor.tsx
    SettingsPanel.tsx
    ConnectionBanner.tsx
  navigation/
    fomo-links.ts                     Verified Fomo URLs
    contract-address.ts               Chain-aware address checks
tests/
  fixtures/fomo-frames.ts
  unit/
  integration/
  e2e/
wxt.config.ts
vitest.config.ts
playwright.config.ts
```

### Task 1: Scaffold the WXT project and test harness

**Files:**
- Create: `package.json`
- Create: `pnpm-lock.yaml` via pnpm
- Create: `tsconfig.json`
- Create: `wxt.config.ts`
- Create: `vitest.config.ts`
- Create: `playwright.config.ts`
- Create: `entrypoints/background.ts`
- Create: `entrypoints/popup/index.html`
- Create: `entrypoints/popup/main.tsx`
- Create: `entrypoints/popup/App.tsx`
- Test: `tests/unit/smoke.test.ts`

- [ ] **Step 1: Add a failing project smoke test**

```ts
// tests/unit/smoke.test.ts
import { describe, expect, it } from "vitest";
import { extensionName } from "../../src/domain/extension";

describe("extension scaffold", () => {
  it("exposes the product name", () => {
    expect(extensionName).toBe("Fomo Live Feed");
  });
});
```

- [ ] **Step 2: Create the package and tool configuration**

```json
{
  "name": "fomo-live-feed",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wxt",
    "build": "wxt build",
    "zip": "wxt zip",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:e2e": "playwright test",
    "check": "pnpm typecheck && pnpm test && pnpm build",
    "postinstall": "wxt prepare"
  },
  "dependencies": {
    "@wxt-dev/module-react": "^1.1.5",
    "dexie": "^4.2.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "@playwright/test": "^1.55.0",
    "@testing-library/jest-dom": "^6.8.0",
    "@testing-library/react": "^16.3.0",
    "@types/react": "^19.1.0",
    "@types/react-dom": "^19.1.0",
    "fake-indexeddb": "^6.2.0",
    "jsdom": "^26.1.0",
    "typescript": "^5.9.0",
    "vitest": "^3.2.0",
    "wxt": "^0.21.2"
  },
  "packageManager": "pnpm@10.15.0"
}
```

```ts
// wxt.config.ts
import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "Fomo Live Feed",
    description: "Show authenticated Fomo trading activity on supported trading pages.",
    permissions: ["storage"],
    host_permissions: [
      "https://fomo.family/*",
      "https://www.fomo.family/*",
      "https://dexscreener.com/*",
      "https://gmgn.ai/*"
    ]
  }
});
```

```json
// tsconfig.json
{
  "extends": ".wxt/tsconfig.json",
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true
  }
}
```

- [ ] **Step 3: Add the minimal entrypoints and implementation**

```ts
// src/domain/extension.ts
export const extensionName = "Fomo Live Feed" as const;
```

```ts
// entrypoints/background.ts
export default defineBackground(() => {});
```

```tsx
// entrypoints/popup/App.tsx
import { extensionName } from "../../src/domain/extension";

export function App() {
  return <main><h1>{extensionName}</h1></main>;
}
```

```tsx
// entrypoints/popup/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>
);
```

- [ ] **Step 4: Install and verify the scaffold**

Run: `pnpm install && pnpm test && pnpm typecheck && pnpm build`

Expected: the smoke test passes, TypeScript reports no errors, and `.output/chrome-mv3/manifest.json` contains only the explicit hosts above.

- [ ] **Step 5: Commit the scaffold**

```bash
git add package.json pnpm-lock.yaml tsconfig.json wxt.config.ts vitest.config.ts playwright.config.ts entrypoints src/domain/extension.ts tests/unit/smoke.test.ts
git commit -m "chore: scaffold WXT extension"
```

### Task 2: Define and validate canonical activity data

**Files:**
- Create: `src/domain/activity.ts`
- Create: `src/fomo/raw-schema.ts`
- Create: `src/fomo/network-map.ts`
- Create: `src/fomo/normalize.ts`
- Create: `tests/fixtures/fomo-frames.ts`
- Test: `tests/unit/fomo-normalize.test.ts`

- [ ] **Step 1: Write failing normalization tests**

```ts
// tests/unit/fomo-normalize.test.ts
import { describe, expect, it } from "vitest";
import { normalizeActivity } from "../../src/fomo/normalize";
import { buyFrame } from "../fixtures/fomo-frames";

describe("normalizeActivity", () => {
  it("maps a Fomo buy into TradeEventV1", async () => {
    const event = await normalizeActivity(buyFrame.payload, 1_800_000_000_000);
    expect(event).toMatchObject({
      schemaVersion: 1,
      source: "fomo",
      sourceEventId: "activity-1",
      traderId: "trader-1",
      chain: "bsc",
      tokenAddress: "0x020bfc650a365f8bb26819deaabf3e21291018b4",
      action: "buy"
    });
  });

  it("rejects activity without a trader or token address", async () => {
    await expect(normalizeActivity({ type: "swap_buy" }, Date.now()))
      .rejects.toThrow("Invalid Fomo activity");
  });
});
```

- [ ] **Step 2: Add canonical types and strict raw schemas**

```ts
// src/domain/activity.ts
export type ChainKey = "solana" | "ethereum" | "bsc" | "base" | "monad" | "unknown";
export type ActivityAction = "buy" | "sell" | "withdraw" | "transfer" | "thesis";

export interface MetricSnapshotV1 {
  pnl7d?: number;
  winRate7d?: number;
  followers?: number;
  tradeCount?: number;
  averageHoldSeconds?: number;
  fetchedAt: number;
  source: "fomo-profile" | "fomo-leaderboard" | "unknown";
}

export interface TradeEventV1 {
  schemaVersion: 1;
  id: string;
  source: "fomo";
  sourceEventId?: string;
  sourceTradeId?: string;
  traderId: string;
  traderHandle: string;
  traderName?: string;
  traderAvatarUrl?: string;
  chain: ChainKey;
  networkId?: number;
  tokenAddress: string;
  tokenSymbol: string;
  tokenImageUrl?: string;
  action: ActivityAction;
  usdAmount?: number;
  marketCap?: number;
  price?: number;
  thesis?: string;
  occurredAt: number;
  receivedAt: number;
  readAt?: number;
  metricSnapshot?: MetricSnapshotV1;
}
```

```ts
// src/fomo/raw-schema.ts
import { z } from "zod";

export const rawActivitySchema = z.object({
  id: z.string().min(1).optional(),
  tradeId: z.string().min(1).optional(),
  type: z.enum(["swap_buy", "swap_sell", "swap_withdraw", "transfer_out", "thesis"]),
  userId: z.string().min(1),
  userHandle: z.string().min(1),
  displayName: z.string().optional(),
  profilePictureLink: z.string().url().optional(),
  ticker: z.string().min(1),
  tokenAddress: z.string().min(1),
  tokenImageUrl: z.string().url().optional(),
  networkId: z.number().int(),
  usdAmount: z.number().finite().nonnegative().optional(),
  marketCap: z.number().finite().nonnegative().optional(),
  price: z.number().finite().nonnegative().optional(),
  createdAt: z.string().datetime(),
  comment: z.union([z.string(), z.object({ comment: z.string() })]).optional()
}).passthrough();
```

- [ ] **Step 3: Implement normalization and deterministic IDs**

Implement `mapNetworkId`, action mapping, ISO timestamp parsing, and SHA-256 fallback IDs in `src/fomo/network-map.ts` and `src/fomo/normalize.ts`. The fallback input must be exactly:

```ts
const fallbackParts = [
  raw.userId,
  raw.type,
  String(raw.networkId),
  raw.tokenAddress.toLowerCase(),
  raw.createdAt,
  String(raw.usdAmount ?? "")
];
```

Throw `new Error("Invalid Fomo activity")` when schema parsing fails. Never guess missing required identity fields.

- [ ] **Step 4: Run focused tests**

Run: `pnpm vitest run tests/unit/fomo-normalize.test.ts`

Expected: both tests pass.

- [ ] **Step 5: Commit canonical activity support**

```bash
git add src/domain/activity.ts src/fomo tests/fixtures/fomo-frames.ts tests/unit/fomo-normalize.test.ts
git commit -m "feat: normalize Fomo activity events"
```

### Task 3: Add IndexedDB repositories and retention

**Files:**
- Create: `src/storage/database.ts`
- Create: `src/storage/event-repository.ts`
- Create: `src/storage/metric-repository.ts`
- Create: `src/background/retention.ts`
- Test: `tests/unit/event-repository.test.ts`
- Test: `tests/unit/retention.test.ts`

- [ ] **Step 1: Write failing persistence tests**

Test these exact behaviors using `fake-indexeddb/auto`:

```ts
it("inserts an event once and returns newest-first pages", async () => {
  expect(await repository.insert(event)).toBe(true);
  expect(await repository.insert(event)).toBe(false);
  expect((await repository.page({ limit: 50 }))[0]?.id).toBe(event.id);
});

it("marks one event read without deleting it", async () => {
  await repository.markRead(event.id, 1234);
  expect((await repository.get(event.id))?.readAt).toBe(1234);
});
```

- [ ] **Step 2: Implement Dexie schema version 1**

```ts
// src/storage/database.ts
import Dexie, { type EntityTable } from "dexie";
import type { TradeEventV1, MetricSnapshotV1 } from "../domain/activity";

export interface MetricCacheRecord extends MetricSnapshotV1 { traderId: string; expiresAt: number; }

export class FomoFeedDatabase extends Dexie {
  events!: EntityTable<TradeEventV1, "id">;
  metrics!: EntityTable<MetricCacheRecord, "traderId">;

  constructor(name = "fomo-live-feed") {
    super(name);
    this.version(1).stores({
      events: "id, occurredAt, [traderId+occurredAt], [chain+occurredAt], [tokenAddress+occurredAt], readAt",
      metrics: "traderId, expiresAt"
    });
  }
}
```

- [ ] **Step 3: Implement repository contracts**

`EventRepository.insert` must use `add` and return `false` only for Dexie's `ConstraintError`. `page` must accept `{ limit, beforeOccurredAt?, traderId?, chain?, tokenAddress?, unreadOnly? }` and never load the entire table. `MetricRepository` must expose `getFresh(traderId, now)` and `put(record)`.

- [ ] **Step 4: Implement bounded cleanup**

`runRetention` deletes at most 500 rows per call. It first deletes events older than 30 days, then deletes oldest overflow rows when count exceeds 20,000. Add tests with injected `now`, `maxAgeMs`, `maxEvents`, and `batchSize`.

- [ ] **Step 5: Verify persistence and commit**

Run: `pnpm vitest run tests/unit/event-repository.test.ts tests/unit/retention.test.ts`

Expected: all persistence, deduplication, paging, read-state, and bounded-cleanup tests pass.

```bash
git add src/storage src/background/retention.ts tests/unit/event-repository.test.ts tests/unit/retention.test.ts
git commit -m "feat: persist local activity history"
```

### Task 4: Add versioned settings and sync-ready annotations

**Files:**
- Create: `src/domain/settings.ts`
- Create: `src/domain/annotations.ts`
- Create: `src/storage/local-preferences.ts`
- Test: `tests/unit/local-preferences.test.ts`

- [ ] **Step 1: Write failing migration tests**

```ts
it("creates MVP defaults for empty storage", async () => {
  expect(await preferences.getSettings()).toMatchObject({
    schemaVersion: 1,
    notifications: { enabled: true, maxVisibleToasts: 3, durationMs: 8000 },
    metrics: { primary: "pnl7d", secondary: "winRate7d" }
  });
});

it("stores annotation tombstones by stable trader ID", async () => {
  await preferences.deleteAnnotation("trader-1", 5000);
  expect(await preferences.getAnnotation("trader-1")).toMatchObject({
    traderId: "trader-1",
    deletedAt: 5000,
    updatedAt: 5000
  });
});
```

- [ ] **Step 2: Define settings and annotation models**

Use the exact `LocalSettingsV1` and `TraderAnnotationV1` shapes from the design specification. Add `DEFAULT_SETTINGS` with three toasts, 8-second duration, sound disabled, and `pnl7d`/`winRate7d` defaults.

- [ ] **Step 3: Implement a storage adapter with dependency injection**

`LocalPreferences` accepts a minimal `{ get, set }` storage area so unit tests use an in-memory fake. All writes replace only their namespaced key (`settings.v1` or `annotations.v1`) and preserve other extension storage.

- [ ] **Step 4: Verify and commit preferences**

Run: `pnpm vitest run tests/unit/local-preferences.test.ts`

Expected: defaults, partial updates, annotations, tombstones, and malformed-storage recovery pass.

```bash
git add src/domain/settings.ts src/domain/annotations.ts src/storage/local-preferences.ts tests/unit/local-preferences.test.ts
git commit -m "feat: add versioned local preferences"
```

### Task 5: Define secure cross-context messaging

**Files:**
- Create: `src/messaging/protocol.ts`
- Create: `src/messaging/guards.ts`
- Test: `tests/unit/messaging.test.ts`

- [ ] **Step 1: Write failing protocol tests**

Cover valid activity candidates, invalid protocol versions, unknown message types, wrong `window` source, and non-Fomo runtime senders.

- [ ] **Step 2: Add a discriminated versioned protocol**

```ts
export type ExtensionMessage =
  | { protocolVersion: 1; type: "activity.ingest"; payload: unknown }
  | { protocolVersion: 1; type: "connection.changed"; payload: { connected: boolean; at: number } }
  | { protocolVersion: 1; type: "events.query"; payload: EventQuery }
  | { protocolVersion: 1; type: "events.markRead"; payload: { ids: string[]; at: number } }
  | { protocolVersion: 1; type: "preferences.changed" };
```

Use Zod to validate the envelope before branching. `isTrustedFomoSender` accepts only tab URLs whose parsed origin is exactly `https://fomo.family` or `https://www.fomo.family`.

- [ ] **Step 3: Verify and commit messaging**

Run: `pnpm vitest run tests/unit/messaging.test.ts`

Expected: all spoofing and version-rejection cases pass.

```bash
git add src/messaging tests/unit/messaging.test.ts
git commit -m "feat: add secure extension messaging"
```

### Task 6: Capture Fomo WebSocket activity

**Files:**
- Create: `entrypoints/fomo-interceptor.content.ts`
- Create: `entrypoints/fomo-bridge.content.ts`
- Test: `tests/unit/fomo-interceptor.test.ts`
- Test: `tests/integration/fomo-bridge.test.ts`

- [ ] **Step 1: Write failing interceptor tests**

Create a fake WebSocket class and verify that only JSON frames with `type: "data"` and `topicType: "trading_activity"` are forwarded. Verify non-JSON, binary, and unrelated-topic frames are ignored.

- [ ] **Step 2: Implement the MAIN-world observer**

Configure WXT with:

```ts
export default defineContentScript({
  matches: ["https://fomo.family/*", "https://www.fomo.family/*"],
  world: "MAIN",
  runAt: "document_start",
  main() { installFomoWebSocketObserver(window); }
});
```

Wrap `window.WebSocket` without altering constructor arguments, prototype identity, static constants, or event delivery. Forward candidates through:

```ts
window.postMessage({ namespace: "fomo-live-feed", protocolVersion: 1, type: "activity.candidate", payload }, window.origin);
```

- [ ] **Step 3: Implement the isolated bridge**

Accept only `event.source === window`, the exact namespace, protocol version 1, and `window.origin` matching an allowed Fomo origin. Send the unknown payload to the service worker only after envelope validation. Emit connection state on page load, WebSocket open/close observation, and page unload.

- [ ] **Step 4: Verify and commit capture**

Run: `pnpm vitest run tests/unit/fomo-interceptor.test.ts tests/integration/fomo-bridge.test.ts`

Expected: valid activity reaches the mocked runtime once; all unrelated or spoofed messages are ignored.

```bash
git add entrypoints/fomo-interceptor.content.ts entrypoints/fomo-bridge.content.ts tests/unit/fomo-interceptor.test.ts tests/integration/fomo-bridge.test.ts
git commit -m "feat: capture authenticated Fomo activity"
```

### Task 7: Ingest, deduplicate, enrich, and broadcast events

**Files:**
- Create: `src/background/ingest-activity.ts`
- Create: `src/background/connection-state.ts`
- Create: `src/background/badge.ts`
- Create: `src/fomo/enrichment-client.ts`
- Modify: `entrypoints/background.ts`
- Test: `tests/unit/ingest-activity.test.ts`
- Test: `tests/unit/enrichment-client.test.ts`

- [ ] **Step 1: Write failing ingest tests**

Verify this order: normalize → insert → immediate broadcast → cached enrichment lookup → optional event update. Duplicate insertions must skip broadcast and enrichment. Invalid payloads must increment a bounded rejection counter without storing the raw payload.

- [ ] **Step 2: Implement enrichment behind an interface**

```ts
export interface TraderMetricSource {
  fetch7dMetrics(traderId: string, signal: AbortSignal): Promise<MetricSnapshotV1 | null>;
}
```

The initial adapter requests `GET https://prod-api.fomo.family/v2/users/{traderId}/leaderboard` with `credentials: "include"`. Parse a metric only when the response explicitly identifies the 7-day window, accepting either `{ pnl7d, winRate7d }` or `{ timeframes: { "7d": { pnl, winRate } } }` inside `responseObject`. Return `null` for 401/403/404, missing 7-day fields, non-finite values, or a non-2xx response; diagnostics record only the status category and trader ID. Never map lifetime PnL or lifetime win rate into `pnl7d` or `winRate7d`.

Before enabling the adapter in the production composition root, capture one successful authenticated response through Chrome DevTools, redact user-identifying fields, and add it as `tests/fixtures/fomo-leaderboard-7d.json`. If the verified production shape differs from both accepted shapes, update the parser and fixture together without weakening the explicit 7-day-window requirement.

- [ ] **Step 3: Compose the background worker**

Create singleton repositories at worker startup, register one `runtime.onMessage` listener, validate senders, and route by discriminant. Broadcast new events to overlay tabs using `browser.tabs.query` followed by `browser.tabs.sendMessage`, ignoring tabs without the overlay content script.

- [ ] **Step 4: Implement badge and connection state**

Badge text is the unread count capped at `99+`. Badge color is purple when connected and gray when no authenticated Fomo bridge has reported activity for 30 seconds. Persist last connection timestamp in `chrome.storage.session`, not local history.

- [ ] **Step 5: Verify and commit orchestration**

Run: `pnpm vitest run tests/unit/ingest-activity.test.ts tests/unit/enrichment-client.test.ts`

Expected: immediate base-event broadcast, duplicate suppression, honest metric fallback, and badge projections pass.

```bash
git add src/background src/fomo/enrichment-client.ts entrypoints/background.ts tests/unit/ingest-activity.test.ts tests/unit/enrichment-client.test.ts
git commit -m "feat: orchestrate live activity ingestion"
```

### Task 8: Build the isolated three-card toast stack

**Files:**
- Create: `src/overlay/toast-queue.ts`
- Create: `src/overlay/ToastStack.tsx`
- Create: `entrypoints/trading-overlay.content/index.ts`
- Create: `entrypoints/trading-overlay.content/style.css`
- Test: `tests/unit/toast-queue.test.ts`
- Test: `tests/unit/ToastStack.test.tsx`

- [ ] **Step 1: Write failing queue tests**

```ts
it("keeps only the newest three visible cards", () => {
  const queue = [event1, event2, event3, event4].reduce(pushToast, []);
  expect(queue.map((event) => event.id)).toEqual([event2.id, event3.id, event4.id]);
});
```

Also test duplicate IDs, manual close, 8-second expiration, and hover pause/resume with fake timers.

- [ ] **Step 2: Implement the pure queue reducer**

The reducer has no browser or React dependencies. It returns oldest-to-newest visible events and enforces the fixed maximum of three.

- [ ] **Step 3: Mount React into a closed Shadow DOM**

The content entrypoint matches only DexScreener and GMGN. Mount one fixed-position host with a z-index below browser chrome but above typical page panels. Use a closed ShadowRoot, adopted style text, and text-only rendering for all remote values.

- [ ] **Step 4: Implement card behavior**

Render avatar fallback, trader label, action, token, chain, amount, relative time, configured metrics, shortened address, copy, close, profile navigation, and token navigation. Hover pauses only that card's timer. A failed image load swaps to a deterministic initials/token fallback.

- [ ] **Step 5: Verify and commit toast UI**

Run: `pnpm vitest run tests/unit/toast-queue.test.ts tests/unit/ToastStack.test.tsx`

Expected: queue, timers, overflow, fallbacks, and actions pass.

```bash
git add src/overlay entrypoints/trading-overlay.content tests/unit/toast-queue.test.ts tests/unit/ToastStack.test.tsx
git commit -m "feat: show real-time activity toasts"
```

### Task 9: Build popup history, search, and filters

**Files:**
- Create: `src/popup/event-query.ts`
- Create: `src/popup/use-event-feed.ts`
- Create: `src/popup/HistoryFeed.tsx`
- Create: `src/popup/EventCard.tsx`
- Create: `src/popup/FilterBar.tsx`
- Create: `src/popup/ConnectionBanner.tsx`
- Modify: `entrypoints/popup/App.tsx`
- Create: `entrypoints/popup/popup.css`
- Test: `tests/unit/event-query.test.ts`
- Test: `tests/unit/HistoryFeed.test.tsx`

- [ ] **Step 1: Write failing query and component tests**

Cover newest-first initial 50 rows, cursor pagination, unread-only, action, chain, trader, token, and normalized text search over handle, display name, annotation label, symbol, and full address.

- [ ] **Step 2: Implement indexed query planning**

Select the most restrictive IndexedDB index first. Apply remaining predicates to the bounded page candidate set. Search input is trimmed and lowercased; address search preserves hexadecimal characters and compares case-insensitively.

- [ ] **Step 3: Implement popup states**

Render exactly four top-level states: login required, Fomo tab offline, connected-empty, and connected-with-history. Opening visible unread rows marks those rows read after rendering and updates the badge.

- [ ] **Step 4: Verify and commit popup history**

Run: `pnpm vitest run tests/unit/event-query.test.ts tests/unit/HistoryFeed.test.tsx`

Expected: paging, filters, search, connection banners, and read-state behavior pass.

```bash
git add src/popup entrypoints/popup tests/unit/event-query.test.ts tests/unit/HistoryFeed.test.tsx
git commit -m "feat: add searchable activity history"
```

### Task 10: Add trader annotations and metric settings

**Files:**
- Create: `src/popup/TraderAnnotationEditor.tsx`
- Create: `src/popup/SettingsPanel.tsx`
- Modify: `src/popup/EventCard.tsx`
- Modify: `entrypoints/popup/App.tsx`
- Test: `tests/unit/TraderAnnotationEditor.test.tsx`
- Test: `tests/unit/SettingsPanel.test.tsx`

- [ ] **Step 1: Write failing annotation tests**

Verify label trimming, maximum 40-character labels, color allowlist validation, pin/mute changes, tombstone deletion, and immediate propagation through `chrome.storage.onChanged`.

- [ ] **Step 2: Write failing metric-setting tests**

Verify defaults are `pnl7d` and `winRate7d`; each slot can be disabled; duplicate primary/secondary selection is rejected; unavailable values render `Unavailable`, not zero.

- [ ] **Step 3: Implement annotation and settings UI**

All user-authored values are rendered as text. Muting hides future toasts but preserves history. Pinning affects popup sorting only when the explicit “Pinned first” toggle is enabled.

- [ ] **Step 4: Verify and commit customization**

Run: `pnpm vitest run tests/unit/TraderAnnotationEditor.test.tsx tests/unit/SettingsPanel.test.tsx`

Expected: annotation persistence, tombstones, mute behavior, and metric selection pass.

```bash
git add src/popup entrypoints/popup/App.tsx tests/unit/TraderAnnotationEditor.test.tsx tests/unit/SettingsPanel.test.tsx
git commit -m "feat: add trader labels and metric settings"
```

### Task 11: Harden navigation, diagnostics, and failure states

**Files:**
- Create: `src/navigation/contract-address.ts`
- Create: `src/navigation/fomo-links.ts`
- Create: `src/background/diagnostics.ts`
- Modify: `src/overlay/ToastStack.tsx`
- Modify: `src/popup/EventCard.tsx`
- Test: `tests/unit/navigation.test.ts`
- Test: `tests/unit/diagnostics.test.ts`

- [ ] **Step 1: Write failing navigation tests**

Cover 40-byte-prefixed EVM addresses, Base58 Solana addresses, unknown-chain rejection, URL encoding, HTTPS-only Fomo origins, and rejection of `javascript:` or user-provided origins.

- [ ] **Step 2: Implement verified link builders**

`buildFomoTokenUrl(chain, address)` returns a `URL` only after chain-specific validation and uses the fixed origin `https://fomo.family`. `buildFomoProfileUrl(handle)` URL-encodes a validated handle. UI code must never concatenate navigation URLs itself.

- [ ] **Step 3: Add bounded redacted diagnostics**

Store at most 100 diagnostic records with `{ code, receivedAt, messageType?, missingFields? }`. Do not store raw payloads, cookies, headers, comments, wallet balances, or arbitrary URLs. Add codes for schema rejection, enrichment failure, storage failure, and disconnected bridge.

- [ ] **Step 4: Verify and commit hardening**

Run: `pnpm vitest run tests/unit/navigation.test.ts tests/unit/diagnostics.test.ts`

Expected: malicious navigation is rejected and diagnostics remain bounded and redacted.

```bash
git add src/navigation src/background/diagnostics.ts src/overlay/ToastStack.tsx src/popup/EventCard.tsx tests/unit/navigation.test.ts tests/unit/diagnostics.test.ts
git commit -m "fix: harden links and diagnostics"
```

### Task 12: Add end-to-end coverage and release documentation

**Files:**
- Create: `tests/e2e/fixtures/fomo-page.html`
- Create: `tests/e2e/fixtures/trading-page.html`
- Create: `tests/e2e/live-feed.spec.ts`
- Create: `docs/development.md`
- Create: `docs/privacy.md`
- Modify: `README.md`

- [ ] **Step 1: Create deterministic local fixtures**

The Fomo fixture constructs a WebSocket-like event source with the same message envelope but contains no production credentials. The trading fixture is a plain host page used to verify Shadow DOM isolation and toast behavior.

- [ ] **Step 2: Add an extension E2E test**

Launch Chromium with `.output/chrome-mv3`, open the two fixtures under test origins permitted only in the test build, emit one buy event, and assert:

```ts
await expect(tradingPage.getByText("$ROBINHOOD")).toBeVisible();
await popupPage.reload();
await expect(popupPage.getByText("$ROBINHOOD")).toBeVisible();
```

Then emit the same event again and assert exactly one history row exists. Emit four unique events and assert exactly three visible toasts.

- [ ] **Step 3: Document development and privacy behavior**

`docs/development.md` must include pnpm setup, dev loading, production build, tests, how to capture and redact an authenticated Fomo fixture, and the supported-host catalog. `docs/privacy.md` must state what is collected, where it is stored, retention defaults, deletion behavior, and that no MVP data is uploaded.

- [ ] **Step 4: Run the complete release gate**

Run: `pnpm check && pnpm test:e2e`

Expected: typecheck, all unit/integration tests, production build, and Chromium E2E tests pass.

Inspect: `.output/chrome-mv3/manifest.json`

Expected: no `<all_urls>`, no cookie permission, no broad scripting permission, and no Side Panel permission.

- [ ] **Step 5: Commit the release-ready MVP**

```bash
git add tests/e2e docs README.md playwright.config.ts
git commit -m "test: verify live feed extension end to end"
```

## Manual validation checkpoint

After Task 12, load `.output/chrome-mv3` in stable Chrome and validate with an authenticated Fomo account:

1. Keep one Fomo tab open and open DexScreener or GMGN.
2. Confirm a followed trader's activity produces one toast without page interaction.
3. Confirm burst behavior never exceeds three visible cards.
4. Confirm closing or logging out of Fomo changes the popup to offline/login-required state.
5. Confirm browser restart preserves history, annotations, settings, and unread state.
6. Confirm changing either metric slot updates both popup and future toasts.
7. Confirm no request sends event history or annotations to a non-Fomo origin.

Do not release until captured production payloads have been redacted and promoted into explicit fixtures, and every fixture passes runtime schema validation.
