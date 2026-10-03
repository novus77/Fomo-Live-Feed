# Fomo Capture Recovery Audit

## Scope and ownership

Approved repair for disconnect-on-navigation and idle capture recovery. Work is
in `codex/english-fomo-fallback`; pre-existing uncommitted audit changes are
preserved. No commits, merges, pushes, releases, authenticated requests, wallet
operations, or changes to the installed Chrome extension were performed.

## Root causes and repair

1. Navigation clears per-tab state even when SPA navigation retains the content
   script. The worker now requests the current bridge state after a Fomo URL
   update or navigation completion. Navigation away from Fomo still clears it.
2. Sticky authenticated state previously disabled DOM fallback indefinitely.
   Authentication and primary capture freshness are now separate. Socket closure
   immediately allows fallback; 15 seconds without valid primary activity allows
   the existing two-second recovery scan without implying logout.
3. Page resumption lacked reconciliation. Visibility, focus and pageshow request
   the current socket snapshot. Persisted pagehide retains authentication but
   marks capture disconnected; resumption never fabricates a socket open.
4. Production observes listener registration while preserving the native socket
   constructor. Original listener options, once/AbortSignal semantics and return
   values are retained. Constructor and prototype observer implementations share
   socket ownership so a socket is observed once even if both are used.
5. DOM ingestion now requires an explicit worker acknowledgement after durable
   persistence or an existing duplicate. Rejections/failures remain retryable.
   Initial/periodic history scans cannot restore the connection. New insertions
   additionally require a reliable absolute clock before being live evidence.
   Insertion/delivery/current lifecycle generations must match; acknowledgements
   and retries predating page suspension cannot revive the resumed connection.

Bounded diagnostics retain only the last recovery reason and timestamp, with
closed codes `socket-closed`, `primary-quiet`, and `page-resumed`.

## Checkpoints

- Bridge close/quiet/resume regressions were demonstrated failing before repair.
- Worker navigation reconciliation regressions failed before capture ping wiring.
- Shared socket observation, late attachment and listener option regressions
  failed before repair.
- Independent review reproduced historical just-now false-online evidence,
  transport-only acknowledgements, moved historical cards, delayed suspended
  acknowledgements and suspended failed-then-retried delivery. Each received a
  failing regression and a verified repair. Final review found no remaining
  Critical or Important issue in the reviewed scope.
- Focused final suites: 190 tests passed across bridge, DOM observer, socket
  interceptor and real worker-boundary tests.
- Final typecheck and production build: exit code 0.
- Final isolated Chromium build checks: four passed (manifest, socket-close/DOM
  recovery and cached-page resume without duplicates, real frame delivery to the
  Side Panel, UI locale switching). The native constructor is asserted in the
  built-extension recovery test.
- Full final suite: 108 files, 2,021 tests passed; exit code 0 (122.91 seconds).
- Candidate artifact: `.output/fomo-recovery-candidate-704VqW/.output/releases/Fomo-Live-Feed-v0.6.1-chrome.zip`.
  SHA-256: `14ea81323d510043a8a5f3c4145a13a7248f2d49e1eea2a214f5c42d19c261ba`.
  Packaged in a fresh directory so existing release artifacts remain unchanged.

## Commands

```sh
node node_modules/typescript/bin/tsc --noEmit
node node_modules/vitest/vitest.mjs run --maxWorkers=1 --testTimeout=60000
node node_modules/wxt/bin/wxt.mjs build
node node_modules/@playwright/test/cli.js test tests/e2e/live-feed.spec.ts --grep 'production manifest|recovers rendered activities|delivers live activity|switches UI locale'
git diff --check
```

The browser checks use a temporary isolated Chromium profile and local HTTPS
fixtures, not the user's browser/profile. The sandbox initially blocked local
test-server binding with EPERM; the approved isolated run succeeded outside that
restriction. Known fake-indexeddb cleanup and browser environment warnings remain;
these are not claimed to be warning-free runs. Intermediate test runs during
review deliberately exposed failing regressions; only the final fixed-source
run is the acceptance gate.

## Limits and next live validation

The previous live inspection showed empty connection state despite recent
captured activities and a page-owned socket constructor distinct from an iframe
constructor. This identifies compatibility risk, not proof that every socket was
bypassing the interceptor. The upstream long-idle failure itself was not captured.

Recovery cannot create events that Fomo no longer delivers or reconstruct a
discarded page. This repair does not refresh tabs or issue private requests. DOM
events with only relative clocks remain ingestible but cannot by themselves
prove a live connection. Isolated fixtures establish plugin recovery behavior,
not uninterrupted upstream production delivery or an actual browser BFCache
eligibility guarantee.

After explicitly approved installation/reload, verify non-trading SPA navigation,
background-tab idle and sleep/wake with fresh upstream events and compare the
bounded socket/frame/candidate/recovery counters. Preserve history and settings.
