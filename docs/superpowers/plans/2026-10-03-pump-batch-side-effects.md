# Pump batch side effects implementation plan

> **For agentic workers:** Use executing-plans, with TDD and local checkpoints.

**Goal:** Reduce Pump's per-trade diagnostic writes and UI invalidations without
changing durable persistence, deduplication, sound eligibility, or checkpoint ACKs.

**Architecture:** Apply bounded aggregation only inside an already validated
Pump batch (maximum 100 items). A batch-local ingestor shares repositories and
business dependencies but injects deferred health recording and a payload-less
invalidation flag. Finalization flushes diagnostic state, invalidates committed
rows, and refreshes the badge before writing the existing Pump checkpoint.
Fomo's immediate path remains unchanged; no background timer or global batch
depth can defer an unrelated source's notifications.

**Tech Stack:** TypeScript, Chrome MV3, Vitest, fake-indexeddb.

## Constraints and alternatives

- Preserve existing health schema/counters. `broadcasts` remains the number of
  logically invalidated events, not the number of runtime messages.
- Default `PersistedPipelineHealth.record(event)` still awaits its write drain.
  Add internal opt-in deferred persistence; snapshots remain current in memory.
- `flush()` must start deferred writes. On write failure retain the latest
  pending snapshot for a later explicit flush or record, with no retry spin.
- A batch owns only constant-size flags, not raw payload arrays or event copies.
- Always finalize a failed batch's durable prefix, and do not checkpoint it.
  Preserve the ingestion error if cleanup also fails; report cleanup separately.
- Keep runtime invalidations best effort, matching current no-listener behavior.
  No durable notification outbox or guaranteed receiver delivery is claimed.
- Deferred: timed aggregation across Fomo messages; it introduces worker
  lifetime/latency semantics beyond this explicit batch boundary.
- No commits, version changes, installed-browser reload, ZIPs, or publishing.

## Task 1: Deferred diagnostic persistence

Files: `src/background/pipeline-health.ts`,
`tests/unit/pipeline-health.test.ts`.

- [x] Add RED tests: sequential deferred records must update snapshot but write
  zero times until explicit flush; one flush writes the final counters.
- [x] Add RED tests: a failed deferred flush retains the latest snapshot and
  a later flush retries once, not an unbounded loop.
- [x] Implement the opt-in path and failure retention:

```ts
async record(event: PipelineHealthEvent, options = { deferPersistence: false }) {
  await this.ready;
  this.state.record(event);
  this.pendingSnapshot = this.state.snapshot();
  if (!options.deferPersistence) await this.ensureWrite();
}
```

- [x] Verify legacy record/write ordering, restoration, defensive reads,
  concurrent recording during writes, and failure recovery.

## Task 2: Batch-local invalidation and finalization

Files: create `src/background/ingestion-batch-effects.ts` and its unit tests;
modify `entrypoints/background.ts` and
`tests/unit/popup-worker-boundary.test.ts`.

- [x] Modify the 100-trade real worker test to require one `events.changed`,
  one health storage write, 100 stored rows, and final health counters at ACK.
  Run before implementation and observe the old 100/300 counts fail.
- [x] Implement batch-local effects with health/event dirty flags and a
  single-flight flush; do not retain event payloads. Failed attempts retain
  dirty work for explicit retry. Finalize health even if invalidation fails.
- [x] Reuse common ingestor dependencies; inject batch effects only for Pump.
  Set invalidation only after successful durable persistence through the
  existing ingestor callback. Flush in finally before checkpoint writes.
- [x] Preserve badge cleanup after batch-effect cleanup fails. Preserve a
  primary ingestion failure over cleanup failures; diagnose each separately.
- [x] Test empty/duplicates/stale/invalid input, persistence failure at first
  and later rows, health failure, badge failure, checkpoint failure, replay,
  overlapping batches, and interleaved Fomo capture.
- [x] Keep detached enrichment and buy sounds outside the boundary wait.

## Task 3: Checkpoint and verification

- [x] Run the focused suites, then full regression, typecheck, MV3 build,
  diff validation, and independent read-only review.
- [x] Update the system audit with operation counts and remaining limits.

Commands (from the existing isolated worktree):

```sh
node node_modules/vitest/vitest.mjs run tests/unit/pipeline-health.test.ts tests/unit/ingestion-batch-effects.test.ts tests/unit/ingest-activity.test.ts tests/unit/popup-worker-boundary.test.ts --maxWorkers=1 --testTimeout=60000
node node_modules/vitest/vitest.mjs run --maxWorkers=1 --testTimeout=60000 --reporter=default --reporter=json --outputFile=.output/pump-side-effects-results.json
node node_modules/typescript/bin/tsc --noEmit
node node_modules/wxt/bin/wxt.mjs build
git diff --check
```

## Completed local checkpoint

The isolated 100-trade worker test retains 100 durable rows and the original
logical health counters while reducing health writes from 300 to one and
`events.changed` messages from 100 to one. Interleaved Fomo activity remains
immediate; shared diagnostic state can consequently flush more than once.

Read-only review identified a single-flight ownership race at the end of a
flush. A regression reproduced a second invalidation being left pending;
ownership now releases before async settlement, and empty flushes acquire their
owner before draining. Re-review found no remaining issues. The final focused
run passed 139 tests across four files; the final full run passed 1,951 tests
across 107 files, with no failures or skipped tests. Type checking, the MV3
build, and diff validation passed. Reports are recorded in the system audit.

No native browser latency or installed-extension verification is inferred from
these tests. All changes remain in the existing isolated worktree, with no
commit, merge, push, package replacement, or release.
