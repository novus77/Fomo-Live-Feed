# Surface filter and Pump gap repair checkpoint

## Scope

Local candidate on `codex/english-fomo-fallback`, version 0.6.1. Existing audit changes remain intact. No commit, merge, push, publication, permission expansion, or deletion of history/settings is included.

## Confirmed causes and repairs

### Feed selection reset

Each recreated `SidePanelApp` previously started with `DEFAULT_FILTERS`; only chain visibility was read from durable preferences. Native Side Panel/PiP switching reproduced the reset in both directions.

The candidate stores source, action visibility, and buy/market-cap ranges in a strict, bounded `chrome.storage.session` snapshot. It hydrates before mounting/querying/acknowledging the feed. Floating host and PiP share the store; handoffs flush pending writes. A failed write prevents the handoff and exposes a retry rather than resetting filters. Chain visibility remains in existing preferences. The browser-session snapshot is not a permanent-settings migration and does not survive restarting Chrome.

### Pump gap reporting

The polling session previously discarded the terminal collector reason. The page status, background gap storage, and live UI projection therefore reported `unspecified` even when the collector knew the cause. The candidate preserves an optional bounded reason end to end, accepts legacy status messages, and shows the historical reason/time in the status tooltip separately from current live delivery.

A regression also proves that a clean, empty newest response was previously classified as `possible-gap`. The candidate leaves its checkpoint unchanged and treats this as no new activity. This exception does not apply to catch-up cursor pages or partially rejected responses. Real endpoint-ended, cursor-loop, age-limit, and event-limit warnings remain unresolved after subsequent live delivery.

## Native observations

- Before updating, selected worker-only diagnostics showed an unresolved gap with `reason: unspecified`, `lastGapAt: 1791006675489`, a populated checkpoint (1,065 recent keys), and catching-up status with no active backoff. No credentials, raw identities, transaction keys, or trade amounts were emitted.
- The local candidate was built and copied to the existing unpacked extension directory. Its background SHA-256 matches the installed file: `91c859e40c0e56666c30f9a37b6d635fab6ef47cfebde213a9fcbdc3c8e96bec`.
- Chrome confirmed reload; existing Pump and Fomo profile pages were refreshed to attach the new collectors.
- Side Panel selection **Pump** remained selected in the floating host and Document PiP. Selecting **Fomo** in PiP remained selected after returning to Side Panel.
- All sources, Chinese locale, dark theme, Side Panel, BSC-only chain visibility, all three action types, and unchanged financial ranges were preserved/restored. No trading, wallet, or follow-list actions were performed.
- Both source statuses were connected/live after restoring the panel. Pump continued displaying the retained historical warning with an explanatory legacy-reason tooltip.
- A read-only, sanitized Pump endpoint check returned HTTP 200 for the head and next cursor page: 10 trades per page, non-repeated cursor, zero cross-page transaction overlap. A separate head check found descending creation/trade timestamps. The newest returned trade was about 8 minutes old, so this window does not verify delivery latency for a newly occurring trade.
- No new gap occurred during this short verification window. The retained warning's latest timestamp was from the older collector (`2026-10-03 13:59:49` local time).

## Limits

The original historical trigger cannot be reconstructed: the installed old code did not retain its reason. The empty-head regression is a confirmed bug, not proof that it caused the observed historical gap. Successful current polling does not establish complete historical recovery. No real upstream gap was induced, no 24-hour/1,000-record API recovery guarantee is made, and no long-running latency/throughput claim is made.

## Verification

- TDD: the new remount/hydration and Pump empty-head/reason-propagation tests failed against the old implementation before repair.
- 143 focused tests passed across eight store, component, collector, polling, protocol, and status suites.
- TypeScript check, production build, and `git diff --check` passed.
- Final full suite: **108 files / 1,966 tests passed**, exit code 0 (267.69 seconds).
- All 30 production files match their installed counterparts by SHA-256.
- The first full run exposed an unintended asynchronous deferral of the legacy
  PiP return callback. The no-store compatibility path was restored before the
  final run. A new failure-path test also checks that a failed session write
  leaves PiP usable rather than starting a lossy return.
