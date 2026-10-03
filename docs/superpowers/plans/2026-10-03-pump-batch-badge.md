# Pump batch badge implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Refresh the unread badge once per Pump batch instead of once per inserted trade, including a conservatively refreshed partial-failure path.

**Architecture:** Keep event validation, ingestion, durable persistence, sounds, per-event broadcasting, enrichment, and checkpoint ordering unchanged. Move badge refresh to the loop's completion boundary. No production timers, shared batch-depth flags, protocol changes, or health-write buffering. Test-only lifecycle isolation is needed to validate exact badge counts reliably.

**Tech Stack:** TypeScript, IndexedDB/Dexie, Vitest, the real worker listener boundary harness.

## Task 1: Coalesce badge refresh at the batch boundary

**Files:**
- Modify: `entrypoints/background.ts` (`ingestPumpBatch` only)
- Test: `tests/unit/popup-worker-boundary.test.ts`
- Test typings: `tests/unit/async-hooks-env.d.ts`

- [x] Add RED regressions through `startWorker/createFakeBrowser/fake.dispatch`: a valid 100-item batch with unique transactions refreshes badge text/color once, produces 100 durable rows, and acknowledges the correct accepted count/checkpoint.
- [x] Confirm no badge refresh for empty, all-duplicate, malformed, or stale-lease batches; preserve their existing checkpoint rules.
- [x] Add a third-item persistence failure test: two rows remain stored, badge becomes 2 exactly once, reply is unsuccessful, and checkpoint does not advance.
- [x] Add a first-item broadcast-completion failure test: the row is already stored although no successful outcome was returned; conservatively refresh its badge once, do not acknowledge progress, and do not checkpoint it. The worker catches runtime send-message failures, so inject a scoped health-recording failure at broadcast completion without changing production broadcast behavior.
- [x] Add cleanup-failure coverage: badge failure on success still prevents checkpoint/ACK; badge failure while ingestion already failed must not replace the primary ingestion error.
- [x] Run targeted tests and watch failures caused by per-item refresh or missing partial-failure cleanup.
- [x] Remove only the loop's per-insert badge call, preserving accepted counting. Apply this boundary:

```ts
let accepted = 0;
let ingestionFailed = false;
try {
  for (const raw of page.accepted) {
    const event = normalizePumpTrade(raw, payload.at, payload.delivery);
    const outcome = await ingestor.ingestNormalized(event, {
      notifyLiveBuy: payload.delivery === 'live',
    });
    if (outcome.status === 'inserted') accepted += 1;
  }
} catch (error) {
  ingestionFailed = true;
  throw error;
} finally {
  if (accepted > 0 || ingestionFailed) {
    try {
      await refreshBadge();
    } catch (error) {
      if (!ingestionFailed) throw error;
      recordStorageFailure();
    }
  }
}
```

- [x] Keep the existing `pump.session.v1` write and successful reply after the boundary. A failed attempt may refresh despite no insert, because a thrown outcome cannot prove that persistence never happened.
- [x] Replace the worker harness's timer-tick startup assumption with observable initialization completion. Register each manual restart separately; release hydration gates and drain pending initialization before database/global cleanup. Preserve immediate `skipBootstrapWait` behavior and exact post-dispatch badge assertions.
- [x] Isolate each simulated worker's asynchronous browser context, including detached connection handlers and health-notification timers. Prior worker work must never update a new fake or access globals after teardown. Verify preceding-Pump-status/malformed-batch and preceding-tab-close/malformed-batch combinations without relaxing exact batch badge assertions or depending on test order.
- [x] Track the inserted outcome's detached enrichment promise before removing its outer ingestion promise. Use a deferred real metric-cache write to verify that acknowledgement remains immediate while teardown waits for enrichment.
- [x] Run `node node_modules/vitest/vitest.mjs run tests/unit/popup-worker-boundary.test.ts tests/unit/ingest-activity.test.ts tests/unit/badge.test.ts --maxWorkers=1 --testTimeout=60000`.
- [x] Obtain spec compliance and code-quality reviews; root-run integrated verification, type checking, and build.
- [x] Record measured badge-call reduction and limitations in the audit. No commits, merges, pushes, package replacement, or installed-extension reload.

## Checkpoint

Independent requirements and code-quality reviews completed. The code-quality
review's nonblocking enrichment-cleanup gap was repaired with a RED-to-GREEN
deferred cache-write regression and rechecked by the root reviewer. The final
targeted set passed 103 tests; the preceding 102-test set passed twice.

After the final test change, the root ran the full unit/integration suite:
101 files, 1,868 passed, zero failures or skipped tests, exit 0. The run used
one worker, a 60-second per-test timeout, and the repository's default Testing
Library async timeout. Root type checking, the Chrome MV3 build, and
`git diff --check` also passed. Evidence:
`.output/followup-final-results.json`.

The verified operation reduction is 100 badge refreshes to one per successful
100-insert Pump batch (100 text/color pairs to one pair), not a real-browser
latency benchmark. Health writes and per-event broadcasts remain unchanged.
Browser E2E, installed-candidate validation, and publication were not performed.

## Deferred work

Health snapshots still use per-event durability. Explicit deferred health recording with boundary flush can reduce those writes, but abrupt worker termination would lose unflushed diagnostic increments; that needs a separate acceptance decision. Per-event `events.changed` remains immediate because coalescing it would change broadcast/enrichment order and duplicate-replay recovery semantics.
