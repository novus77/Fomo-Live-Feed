# Sparse history continuation implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Make deeper matching history reachable when a bounded filter scan returns no visible rows.

**Architecture:** Preserve the existing query protocol, cursor, scan cap, and filter semantics. Render a user-triggered continuation button in the empty scan-exceeded state when `hasMore` is true. No automatic unbounded scanning, persistent-data migration, or card layout changes.

**Tech Stack:** React, TypeScript, Vitest, Testing Library.

## Task 1: Preserve continuation in the empty scan-exceeded state

**Files:**
- Modify: `src/popup/HistoryFeed.tsx`
- Test: `tests/unit/HistoryFeed.test.tsx`

- [x] Add a failing test with `events: []`, `status: 'ready'`, `scanExceeded: true`, `hasMore: true`: the existing load-more action is present and calls `onLoadMore` only on click.
- [x] Add tests that the continuation is disabled and shows the existing loading label while `loadingMore`, and is absent for exhausted/normal empty history, all chains disabled, and initial/error states.
- [x] Run the targeted tests and confirm that failure is missing continuation, not setup/timing failure.
- [x] Reuse the existing `.feed-load-more` button and localized labels without adding card padding or changing the nonempty feed:

```tsx
const pagination = hasMore ? (
  <button type="button" className="feed-load-more" disabled={loadingMore} onClick={onLoadMore}>
    {loadingMore ? translate('feed.loadingMore') : translate('feed.loadMore')}
  </button>
) : null;
```

- [x] Render `pagination` after the existing guidance in the empty scan-exceeded branch and after the list in the nonempty branch. Keep early loading/error/no-chains states unchanged.
- [x] Add an integration-style component test using the real feed hook: 500 nonmatching Fomo rows precede one matching Pump row; ten 50-row requests stop without auto-continuation, click resumes from the existing cursor, and the Pump row becomes visible.
- [x] Run `node node_modules/vitest/vitest.mjs run tests/unit/HistoryFeed.test.tsx tests/unit/event-query.test.ts tests/unit/use-event-feed-filter-key.test.tsx --maxWorkers=1 --testTimeout=60000`.
- [x] Obtain independent spec compliance and code-quality reviews, then root-run type checking and production build.
- [x] Record the checkpoint in the system audit. Do not commit, merge, push, package, or reload the installed extension without user authorization.

## Checkpoint

Independent spec and code-quality reviews passed. The root's selected regression
run included the three feed/query suites plus the installer guide suite: 112
tests passed in four files, with zero failures. It used the repository's default
Testing Library async timeout, one worker, and a 60-second per-test timeout.
Type checking, the Chrome MV3 build, and `git diff --check` exited successfully.
Evidence: `.output/continuation-checkpoint-results.json`.

## Boundaries

The repository's matched-result query can still examine more physical rows than its result limit. A hard scan budget must return a resumable cursor for examined rows; do not truncate results or masquerade a partial scan as exhausted history. Protocol/index design is a separate task.
