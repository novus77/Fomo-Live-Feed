# Fomo Capture Recovery Implementation Plan

> **For agentic workers:** Use executing-plans for inline batches with checkpoints.
> User confirmation authorizes the repair; no Git commits, merges, or publication.

**Goal:** Recover Fomo capture across navigation, socket loss, and page resume.

**Architecture:** Keep authenticated state separate from capture freshness in the
ISOLATED bridge. Reconcile the current MAIN observer and background on navigation
and resume. Retain DOM recovery and existing persistent deduplication.

**Tech Stack:** TypeScript, WXT MV3, Vitest, isolated Chromium fixtures.

## Batch 1: Bridge recovery

Files: `src/fomo/bridge.ts`, `entrypoints/fomo-bridge.content.ts`,
`tests/integration/fomo-bridge.test.ts`.

- [x] Add failing tests: open then close enables fallback; 15-second quiet capture
  enables fallback without a disconnected report; fresh valid activity suppresses
  fallback; DOM delivery restores only newly occurring validated activity; page
  resume/ping republishes state and requests current MAIN socket state; uninstall
  removes all lifecycle listeners.
- [x] Run `node node_modules/vitest/vitest.mjs run tests/integration/fomo-bridge.test.ts`;
  verify new assertions fail before implementation.
- [x] Add bridge methods `shouldUseDomFallback()`, `reportConnection()`, and
  `noteDomActivity(activity: unknown)`. Use a 15,000ms primary freshness window.
  Preserve authentication on persisted pagehide; pageshow/focus request a socket
  snapshot without fabricating an open event. Wire fallback, delivered DOM notes,
  and capture ping to these methods in the content entrypoint.
- [x] Re-run bridge and DOM observer tests; checkpoint the result.

## Batch 2: Navigation reconciliation

Files: `entrypoints/background.ts`, `tests/unit/popup-worker-boundary.test.ts`.

- [x] Add a boundary regression: live connection is cleared by loading, then an
  existing content script re-reports its state when pinged after a Fomo URL update.
  Assert non-Fomo navigation does not receive capture reconciliation requests.
- [x] Run the boundary suite and verify the recovery assertion fails.
- [x] Retain clearing at loading. After Fomo URL updates/navigation completion,
  send `{ protocolVersion: 1, type: 'capture.ping' }` to that tab; ignore missing
  receivers without reading credentials or creating tabs.
- [x] Re-run boundary tests; checkpoint the result.

## Batch 3: Current socket ownership

Files: `src/fomo/websocket-observer.ts`, `entrypoints/fomo-interceptor.content.ts`,
`tests/unit/fomo-interceptor.test.ts`.

- [x] Add failing tests for constructor/prototype observer coexistence, sockets
  constructed through a preserved original constructor, once/AbortSignal options,
  late already-open attachment, and closed-state reconciliation.
- [x] Run interceptor tests and verify failures correspond to missing behavior.
- [x] Share one WeakSet of observed sockets and Set of open sockets per window;
  use prototype interception only in production, preserving the native constructor.
  Retain compatibility with constructor observation in module tests. Forward listener
  arguments unchanged using Reflect.apply. Listen for a same-window, exact-origin,
  namespaced `connection.request` and post current socket state. Remove request
  listeners when the last observer uninstalls.
- [x] Re-run interceptor/bridge suites; checkpoint the result.

## Batch 4: Evidence, verification, build

Files: `src/background/pipeline-health.ts`, `src/messaging/protocol.ts`,
`tests/unit/pipeline-health.test.ts`, `tests/e2e/live-feed.spec.ts`, audit notes.

- [x] Test bounded recovery reason/timestamp diagnostics before implementation.
  Allow only `socket-closed`, `primary-quiet`, `page-resumed` recovery reasons.
- [x] Run focused suites, then `node node_modules/typescript/bin/tsc --noEmit` and
  `node node_modules/vitest/vitest.mjs run --maxWorkers=1 --testTimeout=60000`.
- [x] Build with `node node_modules/wxt/bin/wxt.mjs build`; run isolated Chromium
  manifest, real capture, and lifecycle recovery checks against that build.
- [x] Record observed results and upstream idle limits in audit notes. Leave source
  uncommitted and installed user extension untouched unless separately authorized.

## Review refinements

- [x] Replace transport-only DOM success with a durable worker ACK; failed or
  rejected ingestion retries, while durable duplicates acknowledge successfully.
- [x] Test parser → observer → bridge together, not only preconstructed payloads.
- [x] Require reliable absolute DOM time before restoring connection. Re-mounted
  relative-time history remains eligible for ingestion but not online evidence.
- [x] Fence both insertion and delivery generations across pagehide. Persisted
  acknowledgements and failed-then-retried rows cannot revive suspended evidence.
- [x] Advance the bridge DOM evidence lower bound at suspension.
