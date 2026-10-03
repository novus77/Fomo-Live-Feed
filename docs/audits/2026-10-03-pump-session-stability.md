# Pump Session Stability Checkpoint

## Scope

Local candidate on `codex/english-fomo-fallback`, package version 0.6.1. All previous uncommitted audit and repair changes are retained. No commit, merge, push, publication, permissions expansion, or deletion of user history/settings is authorized by this checkpoint.

## Evidence

### Collector request ownership

The collector previously fenced asynchronous fetch completions with only `active` and a numeric epoch. A replacement worker can reuse that epoch; an expired lease can also reconstruct the polling session without changing the worker or epoch. Deferred-fetch regressions reproduced old successes mutating the replacement session and old authentication/network errors publishing replacement failures or stopping its request. The success path could also expire a replacement lease before confirming request ownership.

The repair captures the polling session object and worker identity before awaiting the request and validates both on success and failure, before consulting the current lease. The existing request-specific controller cleanup remains intact. Normal in-flight lease renewal remains accepted. A separate regression reproduced the previous worker's terminal epoch blocking a replacement worker's renewal; new-session construction now resets that terminal marker while renewals from the terminal session stay blocked.

### Isolated bridge lifecycle

The bridge previously issued a lease request every two seconds even when its preceding reply was pending. Deferred replies could still post lease commands or batch acknowledgements after uninstall. Regressions reproduced four requests in six seconds and both post-uninstall messages. The repair keeps one lease request in flight, releases its guard after failure, and suppresses post-uninstall continuations without changing the message schemas or pagehide notification.

### Worker checkpoint boundary investigation

A read-only audit using synthetic in-memory tests reproduced an obsolete batch writing a checkpoint after the last tab closed and after a replacement leader wrote its checkpoint. Entry validation alone cannot fence the asynchronous persistence/effect boundaries. A third synthetic test delayed application of an already submitted storage write and reproduced session resurrection after a clear. This establishes a contract-level ordering hazard, not evidence that native Chrome storage actually applies writes in reverse order.

The repair revalidates lease ownership when a checkpoint job executes and after
its write, before a successful ACK. Pump checkpoint writes and last-tab clears
share a narrow Promise queue; lease seeds wait for pending writes/clears. Whole
batch ingestion, durable-prefix effects, and Fomo traffic are not serialized by
this queue. Closing an unrelated, untracked tab no longer clears a restored Pump
checkpoint before the first Pump registration. Storage rejection still fails the
current ACK, while a caught queue tail permits subsequent operations to proceed.

Worker regressions verified retained durable rows and their flushed UI effects
when old ACKs are rejected. Collector regressions also verify failed cursor
requests resume the same cursor, duplicate cross-page transactions are emitted
only once in ascending order, later chunks wait for ACK, and uninstall cancels
timers and rejects late successes/failures. Leader tests verify invalidated old
epochs and distinct replacement-worker identities. The current/historical status
tooltip remains compact and is now covered in both UI languages for live,
catching-up, and disconnected states.

## Native observation and limits

A read-only Chrome accessibility inspection found Fomo connected and Pump delayed with the retained legacy history warning (`2026-10-03 13:59:49`, reason unspecified). The selected source was Fomo and chain visibility was BSC-only. No browser settings, tabs, trades, wallets, or follow lists were changed by that inspection. This is not evidence of newly captured Pump trades or their delivery latency.

The old version did not retain the original gap reason. None of these synthetic regressions proves which fault triggered that historical warning. Do not clear the historical warning merely because current delivery later becomes live. Background-tab scheduling, upstream pagination/retention and rate limits still prevent a guaranteed one-second SLA. No long-duration or real upstream fault-injection claim is made.

## Verification checkpoints

- Fresh initial baseline: 4 suites / 19 tests passed.
- Collector/bridge TDD: 9 failed / 12 passed before the ownership/lifecycle repair; the terminal-marker regression then failed independently (1 failed / 21 passed).
- Collector/bridge after repair: 22 tests passed; TypeScript and whitespace checks passed.
- Controller verification: 9 Pump/worker suites / 126 tests passed. This predates the additional worker checkpoint repair and is not the final candidate gate.
- Worker TDD: 4 failures / 1 pass before repair; the five checkpoint lifecycle
  cases passed afterward in a controller-run verification (64 other cases
  skipped).
- Implementer checkpoint after Batch 2: 9 suites / 143 tests, TypeScript, and
  whitespace checks passed. The full controller gate is running separately.

## Final candidate gate

- Specification and then independent quality reviews passed for both batches.
  Batch 1's checkpoint-isolation test was strengthened before approval.
- Fresh full suite: **108 files / 1,994 tests passed**, exit 0, 247.43 seconds.
  Log: `/private/tmp/fomo-pump-stability-full.log`.
- Fresh TypeScript check, production WXT build, and `git diff --check` passed.
- Three isolated Chromium E2E regressions passed, exit 0, 18.8 seconds:
  manifest/least privilege, live Fomo feed without page UI injection, and UI
  language switching without changing opinion-translation settings. The first
  attempt could not bind the localhost fixture server under the sandbox
  (`listen EPERM`); the authorized retry ran with the required local-server
  access. These tests do not establish live authenticated Pump latency.
- Production build background SHA-256:
  `0e5a0b0cef04f98abae105df810ed5d0bb9f6eca32d64e3d653bf138fcfa1ad3`.
- Candidate ZIP: `.output/pump-stability-candidate-qikT04/Fomo-Live-Feed-v0.6.1-pump-stability-candidate.zip`.
  `unzip -t` passed; only production build files are included, with the manifest
  at the root. ZIP SHA-256:
  `cc3bb669e122a2d81c38aa033697f0ced76fc943849e5c2d65d19ac4c828d8ea`.
- The main checkout remains clean. This candidate has not replaced the currently
  installed extension, been committed, merged, pushed, or published. The user
  did not provide a new Chrome-pause reply during this turn; no native update or
  disruptive live fault test was performed. No test-only UI settings need
  restoring because none were changed.

A separate follow-up remains: closing Pump can take up to the existing
30-second connection requery interval to update an already open panel. This
batch does not claim immediate tab-close status notification or resolution of
the original unspecified historical gap.
