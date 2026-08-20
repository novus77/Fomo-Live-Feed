# Fomo Live Feed Browser Extension — MVP Design

## 1. Purpose

Build a Chrome extension that surfaces the authenticated user's Fomo social trading activity while the user is browsing other supported trading platforms.

The MVP has two presentation surfaces:

- Up to three real-time toast cards injected into supported trading pages.
- A toolbar popup containing searchable and filterable message history.

The extension is informational only. It does not place trades, copy trades, access private keys, export Fomo authentication data, or operate trading-platform controls.

## 2. Confirmed MVP Scope

### Included

- Reuse the user's existing Fomo login session.
- Consume activity for traders the user already follows on Fomo.
- Capture real-time Fomo `trading_activity` WebSocket events.
- Enrich trader data on demand through authenticated Fomo REST endpoints.
- Show a maximum of three concurrent toast cards.
- Store message history locally in browser-owned IndexedDB.
- Store settings and trader annotations in `chrome.storage.local`.
- Default trader metrics: 7-day PnL and 7-day win rate.
- Let users hide or replace either default metric.
- Let users assign local labels to traders, pin traders, or mute traders.
- Make the local annotation schema compatible with future multi-device sync.
- Target Chrome for the first supported release.

### Deferred

- Chrome Side Panel.
- Extension-owned trader watchlists.
- Cloud and multi-device sync.
- Backend or third-party activity collection.
- Real-time monitoring while no authenticated Fomo tab is open.
- Same-token multi-trader convergence aggregation.
- In-extension trading, automatic copy trading, and wallet operations.
- Complex analytical reports.

## 3. Data-Source Decision

### Primary path: WebSocket interception

When an authenticated Fomo page connects to `wss://prod-api.fomo.family/ws`, a main-world hook observes JSON frames. Only validated `data` messages with the `trading_activity` topic are forwarded to the extension.

Observed activity payloads may contain:

- Fomo event and trade identifiers.
- Event type, such as buy, sell, withdrawal, transfer, or thesis.
- Trader ID, handle, display name, and avatar URL.
- Token address, symbol, chain/network ID, and token image URL when available.
- USD amount, market cap, price, equity, comment, and timestamps when available.

The extension must treat this as an internal, version-unstable API. Every payload crosses a runtime schema validator before it reaches storage or UI.

### Enrichment path: authenticated REST requests

Trader metrics that are absent from the WebSocket payload are fetched on demand from Fomo user, profile, or leaderboard endpoints using the browser-managed Fomo session.

Enrichment is cached by trader ID and metric window. A message must never wait for enrichment before being displayed. When enrichment is unavailable, the card renders its base activity fields and marks metrics as temporarily unavailable.

### Recovery path

REST polling may be introduced as a limited reconnect-gap recovery mechanism after endpoint behavior is verified. It is not the MVP's primary real-time transport.

### Future path

A third-party or first-party backend may later support extension-owned watchlists, activity while Fomo is closed, richer statistics, and cloud sync. The MVP does not send user data to such a backend.

### Research evidence

- [`fomofaster-ws`](https://github.com/jfferreira97/fomofaster-ws) documents and implements interception of `trading_activity` frames from the Fomo production WebSocket.
- [`Omo`](https://github.com/anondevv69/Omo) demonstrates authenticated access to Fomo user endpoints and fields such as followers, trade counts, and average holding time.
- [`fomo-research-skill`](https://github.com/pooowell/fomo-research-skill) demonstrates a possible future third-party source for activity, positions, PnL, and win-rate data. It is not an MVP dependency.

## 4. Architecture

### 4.1 Main-world interceptor

Responsibilities:

- Observe Fomo-owned WebSocket frames without changing Fomo behavior.
- Parse JSON defensively.
- Forward only candidate `trading_activity` messages.
- Avoid reading or forwarding unrelated network data.

The interceptor communicates with the content script through a namespaced `window.postMessage` envelope. The content script accepts messages only from the same window and only when the envelope and payload pass validation.

### 4.2 Fomo content bridge

Responsibilities:

- Validate the interceptor envelope.
- Convert raw payloads into the extension's versioned transport schema.
- Send validated candidates to the extension service worker.
- Report connection state without exposing cookies or credentials.

### 4.3 Extension service worker

Responsibilities:

- Normalize chain IDs, event types, addresses, timestamps, and optional fields.
- Deduplicate events using source event IDs and a deterministic fallback key.
- Persist events and unread state.
- Maintain metric-cache freshness.
- Distribute events to supported trading tabs.
- Maintain toolbar badge state.
- Expose query and mutation APIs to the popup.
- Track connection health and schema-rejection counters.

The worker must not depend on in-memory state for correctness because Manifest V3 may suspend it at any time.

### 4.4 Supported-site content script

Responsibilities:

- Render toasts inside an isolated Shadow DOM.
- Maintain a three-card visible queue.
- Pause dismissal while a card is hovered.
- Route user actions through validated extension messages.
- Avoid reading or modifying the host site's wallet, form, or order state.

Supported host permissions must be explicit. The extension must not request `<all_urls>`.

### 4.5 Toolbar popup

Responsibilities:

- Render paginated, newest-first history.
- Show unread state and toolbar badge counts.
- Search by trader name, user label, token symbol, or contract address.
- Filter by read state, action, chain, trader, and token.
- Edit trader annotations and display settings.
- Open verified Fomo profile and token links.

The popup is the MVP's history container. Side Panel support is deferred but should reuse the same query and component boundaries.

## 5. Canonical Data Model

### 5.1 Trade event

```ts
type ChainKey =
  | "solana"
  | "ethereum"
  | "bsc"
  | "base"
  | "monad"
  | "unknown";

type ActivityAction = "buy" | "sell" | "withdraw" | "transfer" | "thesis";

interface TradeEventV1 {
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

`id` is the IndexedDB primary key. When Fomo provides a stable source event ID, `id` derives from that ID. Otherwise it derives from a deterministic hash of stable normalized fields.

### 5.2 Metric snapshot

```ts
interface MetricSnapshotV1 {
  pnl7d?: number;
  winRate7d?: number;
  followers?: number;
  tradeCount?: number;
  averageHoldSeconds?: number;
  fetchedAt: number;
  source: "fomo-profile" | "fomo-leaderboard" | "unknown";
}
```

Metric values are snapshots, not guaranteed current values. The UI must label the window correctly and must not silently substitute lifetime metrics for 7-day metrics.

### 5.3 Sync-ready trader annotation

```ts
interface TraderAnnotationV1 {
  traderId: string;
  label?: string;
  color?: string;
  pinned?: boolean;
  muted?: boolean;
  updatedAt: number;
  deletedAt?: number;
}
```

Annotations use stable trader IDs rather than display handles. `deletedAt` is a tombstone reserved for future multi-device conflict resolution.

### 5.4 Local settings

```ts
type MetricKey =
  | "pnl7d"
  | "winRate7d"
  | "followers"
  | "tradeCount"
  | "averageHoldSeconds";

interface LocalSettingsV1 {
  schemaVersion: 1;
  notifications: {
    enabled: boolean;
    maxVisibleToasts: 3;
    durationMs: number;
    soundEnabled: boolean;
  };
  metrics: {
    primary?: MetricKey;
    secondary?: MetricKey;
  };
  filters: {
    mutedChains: ChainKey[];
    minimumUsdAmount?: number;
  };
}
```

Initial defaults are `pnl7d` and `winRate7d`. Either slot may be disabled or replaced.

## 6. Browser-Local Persistence

No database server or local daemon is required. Chrome owns both persistence mechanisms inside the extension's browser profile.

### IndexedDB

IndexedDB stores:

- Trade event history.
- Read state.
- Metric snapshots and cache metadata.
- Storage-maintenance metadata.

Initial event indexes:

- `occurredAt`.
- `[traderId, occurredAt]`.
- `[chain, occurredAt]`.
- `[tokenAddress, occurredAt]`.
- `readAt`.

The popup reads events in pages, initially 50 records at a time. The default retention policy is 30 days or 20,000 events, whichever limit is reached first. Cleanup runs incrementally in bounded batches.

### `chrome.storage.local`

`chrome.storage.local` stores:

- Versioned local settings.
- Trader annotations.
- Feature flags and schema-migration state.

These records are small, low-frequency, and useful to all extension contexts. `chrome.storage.onChanged` propagates configuration changes.

### Future sync boundary

Cloud sync will cover user-authored settings and annotations. Raw event history remains device-local by default. The storage layer must expose repository interfaces so a future remote implementation can be added without rewriting UI components.

## 7. UI and Interaction Design

### 7.1 Toast stack

- Position: bottom-right of supported trading pages.
- Maximum visible cards: three, fixed in the MVP.
- Ordering: newest at the bottom; existing cards move upward.
- Default duration: 8 seconds.
- Hovering pauses dismissal.
- Dismissing a toast does not delete its history record.
- Events beyond the visible capacity enter history and increase the unread badge.
- Reconnect replays do not create duplicate cards.

### 7.2 Card content

A card shows, when available:

- Trader avatar, name, handle, and custom label.
- Buy, sell, or thesis action.
- Token image and symbol.
- Chain badge.
- USD amount and relative event time.
- Default 7-day PnL and 7-day win rate.
- Shortened contract address and copy action.

Actions:

- Card body opens the verified Fomo token page.
- Trader identity opens the verified Fomo trader profile.
- Contract action copies the complete validated address.
- Close dismisses only the visible toast.

### 7.3 Popup history

- Newest-first paginated feed.
- Unread, action, chain, trader, and token filters.
- Search across trader identity, user label, token symbol, and contract address.
- Trader actions: label, color, pin, mute.
- Metric configuration: select, replace, or disable either metric slot.

## 8. Failure Handling

### Authentication

When Fomo is not authenticated, the popup shows a login-required state with an explicit link to Fomo. The extension must not attempt to bypass authentication.

### No active Fomo tab

The MVP requires at least one authenticated Fomo tab to remain open. When none is connected, the popup and badge expose an offline state. Keeping activity live while all Fomo tabs are closed requires a future backend data source.

### WebSocket disconnect

The extension reports disconnected state and waits for the page's reconnection behavior. Event deduplication prevents replayed frames from creating duplicate history or toasts.

### Metric failure

Base activity is displayed immediately. Missing metrics render as unavailable and are retried according to a bounded cache/backoff policy.

### Schema drift

Unknown or invalid messages are rejected from UI and normal event storage. The extension records a bounded, redacted diagnostic containing schema version, missing field names, and message type; it must not persist authentication data or unrestricted raw payloads.

### Browser restart

History, unread state, settings, and annotations survive restart. Real-time delivery resumes after an authenticated Fomo page reconnects.

## 9. Security and Privacy

- Never read, store, or transmit private keys, seed phrases, signatures, or trading credentials.
- Never export Fomo cookies or authentication headers.
- Never automate order controls or execute trades.
- Request only explicit Fomo and supported trading-site host permissions.
- Validate `window.postMessage` source, namespace, version, and payload schema.
- Validate chain-specific contract addresses before copying or building links.
- Permit only known HTTPS origins for external navigation.
- Render untrusted values as text, never unsanitized HTML.
- Do not upload user history, annotations, or settings in the MVP.

## 10. Testing and Release Gates

### Unit tests

- Raw-frame parsing and runtime schema rejection.
- Event normalization and chain mapping.
- Stable fallback deduplication keys.
- Metric formatting and metric-window correctness.
- Filters, search normalization, and unread calculations.
- Settings and annotation migrations.

### Persistence tests

- IndexedDB creation and version upgrades.
- Indexed pagination and ordering.
- Incremental age/count retention cleanup.
- Browser-restart restoration.
- Annotation tombstones and migration compatibility.

### UI tests

- Three-card queue ordering.
- Hover pause and timed dismissal.
- Overflow behavior and badge increments.
- Missing metric and image fallbacks.
- Popup filters, search, labels, pinning, and muting.

### Integration tests

- Simulated Fomo WebSocket frame through interceptor, bridge, worker, storage, and toast.
- Reconnection replay without duplicate UI or history.
- Authentication-loss and recovery states.
- Supported-site Shadow DOM style isolation.

### Manual release checks

- Login and logout on Fomo.
- Fomo tab open, closed, suspended, and reloaded.
- Bursty activity exceeding three simultaneous events.
- Multiple supported trading tabs.
- Browser restart and extension upgrade.
- Link and contract validation for every supported chain.

The MVP release gate targets current stable Chrome. Edge compatibility is expected but is not a blocking first-release requirement.

## 11. Evolution Plan

### Phase 2

- Chrome Side Panel reusing popup repositories and feed components.
- Extension-owned trader watchlists.
- Optional third-party or first-party backend data source.
- Activity delivery without an open Fomo tab.
- Same-token multi-trader convergence signals.

### Phase 3

- Account-backed multi-device sync.
- Sync of settings, annotations, mute state, and pins.
- Field-level conflict resolution using timestamps and deletion tombstones.
- Optional cross-device notification-read state.

Raw historical activity remains local by default unless a later privacy design explicitly changes that decision.

## 12. Acceptance Criteria

The MVP is complete when:

1. An authenticated Fomo activity event appears as a supported-site toast with perceptibly real-time delivery.
2. No more than three toasts are visible concurrently, and overflow events remain available in history.
3. Toolbar history survives browser restart and supports pagination, search, and agreed filters.
4. Default 7-day PnL and win rate render when valid data exists; either can be replaced or disabled.
5. Trader annotations persist locally and use the sync-ready versioned schema.
6. Reconnection does not create duplicate events.
7. Missing enrichment does not block base activity display.
8. The extension functions without any locally installed database or background daemon.
9. The extension does not access trading credentials or execute trades.
10. Automated tests cover the critical parsing, persistence, queue, and migration paths.
