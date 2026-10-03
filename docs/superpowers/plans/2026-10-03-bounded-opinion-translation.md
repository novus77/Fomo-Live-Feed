# Bounded opinion translation

## Scope

Keep existing results, cache semantics, model activation, and card layout. Bound
each coordinator to two active translation pipelines by default, covering
detection through translation. This is not a global native-host limit and does
not claim measured browser latency improvements.

Use FIFO pending jobs with coalescing by text hash and resolved target. An
optional caller AbortSignal releases only that caller's ownership. Remove jobs
with no consumers before they start, and stop abandoned active jobs between
API stages. A native call already in progress retains its slot until it settles;
do not destroy a shared session to cancel one card. Pending capacity remains
proportional to mounted live requests; no silent overflow drops are introduced.

Preserve direct user-gesture `prepare`, existing session LRU/eviction behavior,
and the result union. Visible-row prioritization, virtualization, native API
cancellation, cross-surface limits, and lease expiry are separate work.

## Alternatives

- Selected: coordinator queue plus per-hook cancellation. Small local change,
  preserves the host protocol and independent consumer ownership.
- Deferred: native-host scheduling and cancellation protocol. Would cover all
  clients, but requires broader transport lifecycle and compatibility design.
- Deferred: viewport-priority rendering. Requires UI lifecycle changes and
  actual browser profiling before introducing windowing.

## Checkpoints

- [x] Reproduce unlimited pipelines and stale queued work in targeted tests.
- [x] Implement queue, consumer cancellation, and destruction guards.
- [x] Integrate hook cancellation on replacement, clear, disable, and unmount.
- [x] Verify cache/coalescing, shared ownership, stage boundaries, replacement
  jobs, and destruction; run targeted and full regression suites.
- [x] Run typecheck, MV3 build, diff validation, and read-only code review.
- [x] Record evidence and limitations in the audit; no commit or publication.

## Verification

- Original translation baseline: 3 files / 71 tests passed.
- Initial queue reproduction: 6 failing tests; the unlimited 20-call path,
  unsupported cancellation, and destruction-during-hash behavior were observed.
- Final targeted group: 9 files / 209 tests passed.
- Final full suite: 106 files / 1,935 tests passed, zero failed/skipped.
- Typecheck, Chrome MV3 build (~1.27 MB), and diff validation passed.
- Read-only review found no blocking issues; independently ran 79 tests before
  the final three regression additions. Root final runs cover all changes.
- Evidence and remaining limitations are recorded in
  `docs/audits/2026-10-03-system-performance-and-fomo-capture.md`.
