# Resumable history scan budget implementation plan

> **For agentic workers:** Use executing-plans in the current session. Preserve the existing dirty repairs and obtain a read-only review before the checkpoint.

**Goal:** Bound sparse feed queries by examined records without losing history behind an empty or short page.

**Architecture:** Add an opt-in bounded repository scan using existing IndexedDB indexes and a native reverse cursor. Return events, last examined composite cursor, scanned row count, conservative hasMore, and scanExceeded. Use continuePrimaryKey to seek within tied timestamps rather than repeatedly traversing already-consumed rows. Keep legacy EventRepository.page and queryEvents semantics unchanged. New queryEventPage opts into progress through an optional transport flag; loadEventPages accepts either the legacy array or explicit progress. No database migration, stored event change, index change, network capture change, or automatic unbounded continuation is included.

**Tech Stack:** TypeScript, IndexedDB/Dexie, fake-indexeddb, Vitest, Testing Library.

**Budget:** At most 500 candidate rows per repository request, plus at most two cursor-positioning responses for a composite continuation. Stop without lookahead at the match limit or scan budget. hasMore is deliberately conservative at an exact boundary; the next request can observe exhaustion. A physical-budget stop returns control to the user through the existing scan-exceeded continuation action. Existing popup-side search/source/action/range scans retain their ten-page cap.

## Task 1: Repository reproduction and bounded scan

Files: `src/storage/event-repository.ts`, `tests/unit/event-repository.test.ts`.

- [x] Run the existing repository/query/hook baseline with one worker and unchanged async timeout.
- [x] Add failing real-IndexedDB tests: 20,000 read rows and an older unread row; default scan must stop at 500 with no matches and a resumable cursor. Count actual openCursor success callbacks, not a mocked repository counter.
- [x] Test tied timestamps, indexed filters, missing cursor rows, strict timestamp-only cursors, empty databases, exact-boundary exhaustion, invalid budgets, and cursor progress.
- [x] Implement `scanPage(query, maxScanRows = 500)` while preserving legacy `page`.

```ts
export interface ScannedEventPage {
  events: TradeEventV1[];
  cursor: { beforeOccurredAt: number; beforeId: string } | null;
  hasMore: boolean;
  scanExceeded: boolean;
  scannedRows: number;
}
```

## Task 2: Compatible query transport and client

Files: `src/messaging/protocol.ts`, `entrypoints/background.ts`, `src/popup/popup-io.ts`, `tests/unit/popup-worker-boundary.test.ts`, new `tests/unit/query-event-page.test.ts`.

- [x] Add failing opt-in tests through the real worker listener, retaining legacy array query tests.
- [x] Accept optional boolean `includeScanProgress`; false/absent uses legacy repository.page. True returns bounded events and optional `page` metadata.
- [x] Add `queryEventPage` with the same row validation/redacted diagnostic handling as queryEvents, validating progress separately and preserving progress when malformed rows are dropped.
- [x] Retain array replies for legacy injected clients; malformed or stalled explicit progress must fail rather than silently loop or claim exhaustion.

## Task 3: Feed pagination and continuation

Files: `src/popup/event-query.ts`, `src/popup/use-event-feed.ts`, `src/sidepanel/SidePanelApp.tsx`, `tests/unit/event-query.test.ts`, `tests/unit/use-event-feed-filter-key.test.tsx`.

- [x] Add failing pagination tests for empty progress pages, short pages with more history, budget stops, invalid/nonadvancing cursors, and legacy arrays.
- [x] Use explicit last-examined cursors rather than the last matched row when present. Never treat an empty progress page as exhaustion if hasMore is true.
- [x] Stop on physical scanExceeded with hasMore and a cursor; preserve the existing manual continuation and normal post-filter page cap.
- [x] Switch only the panel fetch callback to queryEventPage; read marking must remain limited to rendered eligible events.
- [x] Test real sparse unread history resumes to the older match without marking unseen rows read.

```ts
type EventPageResult = TradeEventV1[] | ScannedEventPage;
// Explicit metadata determines continuation; arrays retain existing behavior.
```

## Task 4: Review and local checkpoint

- [x] Run repository/query/client/hook/worker regression suites, inspect fresh results, and obtain read-only review.
- [x] Run full tests: `node node_modules/vitest/vitest.mjs run --maxWorkers=1 --testTimeout=60000 --reporter=json --outputFile=.output/scan-budget-results.json`.
- [x] Run `node node_modules/typescript/bin/tsc --noEmit`, `node node_modules/wxt/bin/wxt.mjs build`, and `git diff --check`.
- [x] Update `docs/audits/2026-10-03-system-performance-and-fomo-capture.md` with actual cursor-response counts and limitations. No Git commit, merge, push, ZIP replacement, or installed-browser performance claim.

Legacy callers and recovery reconciliation still use page without this new budget. Real browser latency and translation concurrency remain separate work.
