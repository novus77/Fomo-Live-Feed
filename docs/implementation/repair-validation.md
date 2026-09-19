# Repair validation

## RP00 baseline

| Date | Command | Exit code | Result |
|---|---|---:|---|
| 2026-09-19 | `pnpm check` | 1 | Environment preflight failed before project checks: pnpm 11 attempted registry metadata fetch and non-interactive module-directory purge. |
| 2026-09-19 | `./node_modules/.bin/vitest run tests/unit/event-repository.test.ts tests/unit/event-deduplication.test.ts tests/unit/ingest-activity.test.ts tests/unit/popup-worker-boundary.test.ts` | 0 | 102 tests passed; IndexedDB close notices only. |
| 2026-09-19 | `./node_modules/.bin/tsc --noEmit` | 0 | Typecheck passed after RP01/RP02 changes. |
| 2026-09-19 | `./node_modules/.bin/vitest run tests/unit` | 0 | 94 files / 1,737 tests passed. |
| 2026-09-19 | `./node_modules/.bin/wxt build` | 0 | Chrome MV3 production build completed. |
| 2026-09-19 | `./node_modules/.bin/vitest run tests/unit/popup-worker-boundary.test.ts -t "does not advance the Pump checkpoint"` | 0 | Actual worker rejects a mixed-validity Pump batch without advancing session state. |
| 2026-09-19 | `./node_modules/.bin/vitest run tests/unit/local-preferences.test.ts` | 0 | 44 tests passed, including concurrent annotation mutation preservation. |
| 2026-09-19 | `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run tests/unit/popup-worker-boundary.test.ts tests/unit/SidePanelApp.test.tsx tests/unit/messaging.test.ts tests/unit/local-preferences.test.ts` | 0 | 4 files / 331 tests passed. Trusted UI annotation mutations persist through the real worker; Fomo-tab writes are rejected. |
| 2026-09-19 | `./node_modules/.bin/wxt build` | 0 | Chrome MV3 production build completed after the annotation writer route. |
| 2026-09-19 | `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run tests/unit/use-event-feed-filter-key.test.tsx tests/unit/SidePanelApp.test.tsx` | 0 | 2 files / 45 tests passed. Source-ineligible rows remain unread; Pump-eligible rows are marked after worker confirmation. |
| 2026-09-19 | `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run tests/unit/local-preferences.test.ts tests/unit/messaging.test.ts tests/unit/popup-worker-boundary.test.ts tests/unit/SidePanelApp.test.tsx tests/unit/use-event-feed-filter-key.test.tsx && ./node_modules/.bin/wxt build` | 0 | 5 files / 337 tests and Chrome MV3 build passed. Settings patches are schema-bounded, sender-guarded, and merged by the worker. |
| 2026-09-19 | `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run tests/unit/LocaleProvider.test.tsx tests/unit/SidePanelApp.test.tsx tests/unit/messaging.test.ts tests/unit/popup-worker-boundary.test.ts` | 0 | 4 files / 298 tests passed. Locale persistence now uses the injected worker mutation writer when supplied. |
| 2026-09-19 | `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run tests/unit/preference-mutation-coordinator.test.ts tests/unit/local-preferences.test.ts tests/unit/LocaleProvider.test.tsx tests/unit/SidePanelApp.test.tsx tests/unit/messaging.test.ts tests/unit/popup-worker-boundary.test.ts tests/unit/use-event-feed-filter-key.test.tsx && ./node_modules/.bin/wxt build` | 0 | 7 files / 349 tests and Chrome MV3 build passed. The coordinator returns a prior receipt for a repeated mutation ID and replays a pending annotation on startup. |
| 2026-09-19 | `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run tests/unit/preference-mutation-coordinator.test.ts tests/unit/popup-settings-mutation.test.ts tests/unit/local-preferences.test.ts tests/unit/LocaleProvider.test.tsx tests/unit/SidePanelApp.test.tsx tests/unit/messaging.test.ts tests/unit/popup-worker-boundary.test.ts tests/unit/use-event-feed-filter-key.test.tsx && ./node_modules/.bin/wxt build` | 0 | 8 files / 351 tests and Chrome MV3 build passed. Settings and annotation clients use the same mutation ID for one lost-ACK retry. |
| 2026-09-19 | `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/vitest run tests/unit/source-read-eligibility.test.ts tests/unit/use-event-feed-filter-key.test.tsx tests/unit/SidePanelApp.test.tsx` | 0 | 3 files / 51 tests passed. A Pump-live/Fomo-offline panel only marks the Pump-visible row; merged rows honor the active source filter and the owner gate. |
| 2026-09-19 | `./node_modules/.bin/vitest run tests/unit tests/integration` | 0 | Current unit and integration suites passed after RP08–RP11 changes; IndexedDB close notices and one pre-existing React `act(...)` warning were non-fatal. |
| 2026-09-19 | `./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/wxt build && git diff --check` | 0 | Typecheck, Chrome MV3 production build, and whitespace validation passed. |
| 2026-09-19 | `./node_modules/.bin/vitest run tests/unit/fomo-normalize.test.ts tests/unit/event-repository.test.ts tests/unit/popup-worker-boundary.test.ts --testNamePattern='network catalog|bootstrap reclassifies|reclassifies only' && ./node_modules/.bin/tsc --noEmit && ./node_modules/.bin/wxt build && git diff --check` | 0 | Catalog evidence/runtime split, source-aware reclassification, typecheck, production build, and diff validation passed. |

## Verification policy

- Archived reproduction sources are evidence only and are never imported by project tests.
- A task is not marked verified until a current-project regression has been observed failing before its production fix and passing afterward.
- Browser, minimum-Chrome, and authenticated Fomo/Pump checks remain separately recorded from automated tests.
