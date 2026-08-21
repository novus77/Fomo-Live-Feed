# Fomo Live Feed

A Chrome extension that surfaces real-time activity from traders the
authenticated Fomo user follows, while browsing supported trading platforms.
Activity arrives as a small toast stack in the corner of the trading page and
is stored as a searchable, filterable history in Chrome's Side Panel.

> **MVP status:** implemented and covered by unit, integration, and end-to-end
> tests. The production Fomo enrichment and REST backfill adapters remain
> deliberately disabled until real authenticated responses are captured and
> redacted (see [docs/development.md](docs/development.md)); until then toasts
> render base activity fields with metrics marked unavailable and reconnect
> backfill is unavailable. The manual release checklist in the implementation
> plan has **not** been run against a real authenticated Fomo account yet.

## Quick start

Requires Chrome 138 or newer (for the Side Panel and on-device opinion
translation).

```bash
pnpm install
pnpm dev        # development build with live reload
pnpm build      # production build -> .output/chrome-mv3
```

Load the current local build at `.output/chrome-mv3` as an unpacked extension in Chrome
(`chrome://extensions` → Developer mode → *Load unpacked*). Keep one
authenticated Fomo tab open, refresh it after loading/reloading the extension,
then click the extension action to open the Side Panel. Open DexScreener or
GMGN and watch for toasts as followed traders trade.

## What it does

- **Real-time capture** — a MAIN-world interceptor observes the Fomo
  production WebSocket and forwards only validated `trading_activity`
  frames to an isolated bridge, which passes them to the service worker
  (no cookies, headers, or tokens ever cross the boundary).
- **Toast stack** — up to **three** concurrent cards in a closed Shadow DOM on
  supported trading pages; newest at the bottom, hover pauses dismissal,
  overflow stays in history (design spec section 7.1).
- **Side Panel history** — newest-first paginated feed with unread state, search
  across trader identity / token / address, filters by action/chain/trader/
  token through a compact filter popover, trader labels/colors/pins/mutes,
  chain badges, full copyable contract addresses, and replaceable metric slots
  (defaults: 7-day PnL and 7-day win rate).
- **Local persistence** — event history in IndexedDB (Dexie); settings and
  sync-ready trader annotations in `chrome.storage.local`; connection state
  in `chrome.storage.session`. Retention defaults: 30 days or 20,000
  events, whichever comes first, cleaned up in bounded batches.
- **Deduplication** — stable event IDs mean reconnect replays never create
  duplicate history rows or duplicate cards.
- **Localization** — UI available in English and Simplified Chinese; trader
  thesis comments can be translated on-device with Chrome 138's built-in AI
  translator (no external service).
- **Feed recovery** — after reconnect or a manual refresh, the extension can
  backfill missed live activity from Fomo's authenticated history endpoint
  (disabled until a verified capture exists).

## Architecture

```text
Fomo page (MAIN world interceptor) --postMessage--> Fomo bridge (ISOLATED world)
  --> service worker (ingest: normalize -> insert -> broadcast -> enrich)
  --> trading overlay content script (closed Shadow DOM toasts)
  --> Chrome Side Panel (history, search, filters, annotations, diagnostics)
```

The service worker is a thin composition root over injectable modules; every
cross-context message crosses a versioned, sender-validated protocol
(`src/messaging/`), and content scripts never run on `<all_urls>`.

## Supported chains

The extension recognizes six product chains plus an `unknown` sentinel. All
Fomo network-ID mappings are currently **provisional-unverified** and render as
`unknown` until a real authenticated capture promotes them:

- BSC, Solana, Robinhood, Base, Ethereum, X Layer

`monad` and other chains are deliberately out of scope.

## Supported hosts

| Host | Role |
| --- | --- |
| `https://fomo.family/*`, `https://www.fomo.family/*` | Fomo capture (interceptor + bridge) |
| `https://dexscreener.com/*`, `https://gmgn.ai/*` | Toast overlay |

Host permissions are declared only in `wxt.config.ts` and mirrored by the
content-script matches — there is no `<all_urls>` or cookie permission; the
only non-storage API permission is the required `sidePanel` permission.

## Documentation

- [Development guide](docs/development.md) — setup, dev loading, builds,
  tests, how to capture and redact an authenticated Fomo fixture, and the
  supported-host catalog.
- [中文手工测试指南](docs/manual-testing.zh-CN.md) — 安装扩展、真实账号测试、
  异常恢复、证据脱敏及问题反馈模板。
- [Privacy and data handling](docs/privacy.md) — what is collected, where it
  is stored, retention defaults, deletion behavior, and the no-upload
  guarantee.
- [Design specification](docs/superpowers/specs/2026-08-20-fomo-live-feed-extension-design.md)
- [Implementation plan](docs/superpowers/plans/2026-08-20-fomo-live-feed-extension.md)

## MVP boundaries

- Informational only: the extension never places trades, copies trades, or
  touches wallet state, and never reads private keys or credentials.
- Requires at least one authenticated Fomo tab to remain open for real-time
  delivery (no backend data source in the MVP).
- Chrome 138+ is required for the on-device translation model and Side Panel
  features; browser-local persistence only.
- Real-time monitoring while Fomo is closed and cloud sync are not enabled.
  REST recovery is implemented but disabled pending authenticated, redacted
  evidence and a separate review.
