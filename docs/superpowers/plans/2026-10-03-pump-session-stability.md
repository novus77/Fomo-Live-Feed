# Pump Session Stability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent obsolete Pump asynchronous work from changing a replacement session, and verify bounded recovery without hiding genuine historical gaps.

**Architecture:** Keep the existing page collector, isolated bridge, worker leader, committed checkpoints, and gap store. Fence collector completions with the request's worker identity and polling-session identity, not just an epoch that can be reused after worker restart. Serialize bridge lease requests and ignore continuations after uninstall. No protocol, storage migration, permissions, retention, or trading behavior changes.

**Tech Stack:** TypeScript, WXT MV3, Vitest fake timers, React Testing Library.

## Scope and baseline

Reuse `.worktrees/english-fomo-fallback` on `codex/english-fomo-fallback`; preserve all earlier uncommitted repairs. No commits, merge, push, release, or replacement of published packages. The previous native gap has `unspecified` from old code; its original trigger remains unknown. A passing synthetic fault test cannot establish that trigger.

Fresh baseline: collector, bridge, leader, status suites: 4 files / 19 tests passed.

## Batch 1: Request ownership and bridge lifecycle

**Files:**
- Modify `src/pump/page-collector.ts`
- Modify `src/pump/bridge.ts`
- Test `tests/unit/pump-page-collector.test.ts`
- Test `tests/integration/pump-bridge.test.ts`

- [ ] Add deferred-fetch tests for replacement worker with the same epoch: late success, late authentication/network failure, and no contamination of the replacement checkpoint. Add same-worker expired-lease/session-reset coverage. Assert emitted batch worker ID, items/checkpoint, status, and bounded fetch counts.
- [ ] Add deferred bridge reply tests: while one lease request is pending, advancing multiple 2-second ticks must not start another; resolving after uninstall must not post a lease or batch ACK; failures release the single-flight guard for a later tick.

Test assertion anchors (use the existing window and fixture helpers):

```ts
expect(fetchFn).toHaveBeenCalledTimes(1);
expect(target.posted).not.toContainEqual(expect.objectContaining({
  message: expect.objectContaining({
    payload: expect.objectContaining({ status: 'authentication-required' }),
  }),
}));
expect(pumpWindow.postMessage).not.toHaveBeenCalled();
```

- [ ] Run before production edits, record failing test names and causes:

```sh
node node_modules/vitest/vitest.mjs run tests/unit/pump-page-collector.test.ts tests/integration/pump-bridge.test.ts --maxWorkers=1 --testTimeout=60000
```

- [ ] Capture request ownership before awaiting fetch. Apply the identical ownership guard on success and failure. Only a request that still owns the current session may expire that lease, mutate checkpoints/backoff, stop collection, or publish statuses. Keep request-specific controller cleanup in `finally`.
- [ ] Reset the old worker's terminal epoch when constructing a replacement polling session. A genuine terminal failure must still block renewals from the same worker/session.

Implementation anchor:

```ts
const pollingSession = session;
const pollingWorkerSessionId = workerSessionId;
const ownsSession = (): boolean => active && epoch === pollingEpoch &&
  workerSessionId === pollingWorkerSessionId && session === pollingSession;
```

- [ ] Add bridge active/disposed and lease-in-flight guards. Release in-flight in `finally`; suppress lease and ACK posts after disposal. Keep pagehide notification and existing lease/ACK wire schemas unchanged.

```ts
let active = true;
let leaseInFlight = false;
// In requestLease, before sendMessage:
if (!active || leaseInFlight) return;
leaseInFlight = true;
// After the awaited reply, before changing state or posting:
if (!active) return;
// In finally:
leaseInFlight = false;
// First action in uninstall:
active = false;
```

- [ ] Rerun the two suites; obtain specification review, then quality review. Do not commit.

## Batch 2: Fault recovery and status regression coverage

Batch 1 checkpoint: implemented and reviewed against specification, then quality.
Collector/bridge 22 tests, TypeScript, and whitespace checks passed. The reviewer
requested distinct obsolete/replacement transactions and checkpoint assertions;
these were added before specification approval. No commits were made.

**Files:**
- Modify `entrypoints/background.ts` (Pump checkpoint/clear boundaries only)
- Test `tests/unit/pump-page-collector.test.ts`
- Test `tests/unit/pump-leader.test.ts`
- Test `tests/unit/PumpStatusIndicator.test.tsx`
- Test `tests/unit/popup-worker-boundary.test.ts`
- Read `tests/unit/popup-worker-boundary.test.ts` and existing polling/catch-up suites

- [ ] Verify network failure during cursor recovery keeps the last committed checkpoint and cursor; recovery emits ascending unique transactions only after ACK. Verify uninstall during catch-up cancels timers and rejects late continuations. Verify closing/removing the old leader invalidates its epoch, selects one waiting tab, and a restarted coordinator gets a distinct worker identity.
- [ ] Inspect existing worker tests for duplicate batches and persisted checkpoints before adding redundant tests. Keep genuine gap warnings after later live statuses.
- [ ] A read-only audit reproduced stale checkpoint writes after closing the last Pump tab and after electing a replacement leader. Add deterministic gated-persistence tests in the worker boundary suite. The obsolete batch must fail its ACK, preserve already persisted rows and flush their effects, and never overwrite a replacement checkpoint or resurrect a cleared session.
- [ ] Serialize only Pump checkpoint writes and session clears, not entire batch ingestion or other sources. Test a delayed checkpoint write already submitted before tab close: its clear must run after it. Await pending checkpoint/clear writes before reading the next lease seed. Revalidate ownership before a queued checkpoint write and before successful ACK. Do not claim the synthetic out-of-order storage test proves Chrome's native implementation reorders requests.

Queue implementation anchor at the composition root:

```ts
let pumpSessionWrites = Promise.resolve();
const queuePumpSessionWrite = (write: () => Promise<void>): Promise<void> => {
  const result = pumpSessionWrites.then(write);
  pumpSessionWrites = result.catch(() => {});
  return result;
};
```

Checkpoint ownership remains the existing predicate:

```ts
payload.workerSessionId === pumpLeader.workerSessionId &&
  pumpLeader.isCurrent(tabId, payload.epoch, Date.now())
```

Use that predicate at the queue execution boundary and after the write, but always complete existing durable-prefix side-effect flushing. Storage failure remains a failed ACK; the queue tail recovers only so subsequent operations can run.
- [ ] Verify current live/catching-up/disconnected status stays distinct from the historical warning, with bounded reason/time in English and Chinese. Existing status tooltip already implements this behavior; extend tests without adding another row or a dismiss action.

```ts
expect(screen.getByRole('status', { name: 'Pump: Live · History gap' }))
  .toHaveAttribute('title', expect.stringContaining('previous checkpoint'));
```

- [ ] Run all Pump tests and the worker boundary suite:

```sh
node node_modules/vitest/vitest.mjs run tests/unit/pump-page-collector.test.ts tests/integration/pump-bridge.test.ts tests/unit/pump-leader.test.ts tests/unit/pump-polling-session.test.ts tests/unit/pump-catch-up.test.ts tests/unit/pump-backoff.test.ts tests/unit/pump-http-client.test.ts tests/unit/PumpStatusIndicator.test.tsx tests/unit/popup-worker-boundary.test.ts --maxWorkers=1 --testTimeout=60000
```

- [ ] Fix only reproduced failures; review specification then quality. No changes to the initial-history exclusion or 24-hour / 1,000-record catch-up bounds.

## Batch 3: Candidate checkpoint

**Files:**
- Create `docs/audits/2026-10-03-pump-session-stability.md`
- Build `.output/chrome-mv3` only

- [ ] Run fresh complete verification:

```sh
node node_modules/vitest/vitest.mjs run --maxWorkers=1 --testTimeout=60000
node node_modules/typescript/bin/tsc --noEmit
node node_modules/wxt/bin/wxt.mjs build
git diff --check
```

- [ ] Record actual results, reproduced faults, current native evidence if safely obtained, and limits. Do not claim the old unspecified warning is resolved or newly occurring real trades have been observed without evidence. Do not clear history/settings or induce real trades.
- [ ] For native update/diagnostics, request a fresh short Chrome pause when needed; preserve the existing unpacked installation and restore all test-only settings. Otherwise deliver the verified local build with native verification explicitly pending.
- [ ] Report the candidate and remaining limitations, without publishing or committing.

## Execution outcome

- [x] Batch 1: deferred-request faults reproduced, ownership/lifecycle/terminal
  fixes implemented, checkpoint test strengthened, specification and quality
  review passed.
- [x] Batch 2: four worker lifecycle failures reproduced; checkpoint/clear queue
  and seed fencing implemented; 17 additional recovery/lifecycle/status cases
  added; specification and quality review passed.
- [x] Batch 3: 108 files / 1,994 tests, TypeScript, production build, whitespace
  check, and 3 isolated Chromium E2E regressions passed. Candidate ZIP and
  checksum generated without replacing installed or published packages.
- [x] Native checkpoint: read-only status inspection recorded; no new Chrome
  pause confirmation arrived. Deliver the verified candidate with installed
  candidate/live-fault verification explicitly pending, per this plan's fallback.

Detailed evidence, artifact hash, and unresolved boundaries are recorded in
`docs/audits/2026-10-03-pump-session-stability.md`. No commits, merge, push, or
publication were performed. Preserve the existing worktree for user validation.
