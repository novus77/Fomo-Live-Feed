# Code Quality Review — Streamlined Feed, Verified Chain, and Local Translation

**Date:** 2026-08-21
**Scope:** All files changed for Tasks 1–7
**Verdict:** PASS (clean TypeScript, tests green, no dead references, git diff check clean)

## Strengths

- **Type safety:** `LocalSettingsV3` is a distinct type from `V1`/`V2`; migration helpers are typed and the storage adapter returns `LocalSettingsV3` everywhere after migration.
- **Defensive validation:** Zod schemas for V1/V2/V3 settings reject corrupt records and fall back gracefully to defaults or older versions.
- **Test coverage:** 1166 unit/integration tests and 11 E2E tests pass. New/updated tests cover V3 migration, controls-free Side Panel, inline followers, and E2E settings v3 seeding.
- **Separation of concerns:** `FilterToolbar`/`ActiveFilterChips` moved to `src/popup/`, keeping the side-panel composition root focused.
- **No dead UI references:** `.event-metrics`/`.toast-metrics` CSS removed; metric label catalog keys removed; `readMetric`/`formatMetricValue`/`METRIC_LABEL_KEYS` removed.

## Findings

### 1. `formatPnl`, `formatWinRate`, `formatDuration` are only exercised by tests

- **Files:** `src/overlay/format.ts`, `tests/unit/format.test.ts`
- **Impact:** Low. They are utility formatters no longer used by production UI, but they are well-tested and could be useful if metrics return later.
- **Recommendation:** Leave them in place; removing them would be churn with no user benefit. If a stricter dead-code policy is adopted, delete them in a follow-up.

### 2. `FilterToolbar` styling lives in `entrypoints/sidepanel/sidepanel.css`

- **File:** `entrypoints/sidepanel/sidepanel.css`
- **Impact:** Low. The real extension only has a side-panel entrypoint; the deprecated `PopupApp` wrapper renders inside the same CSS context, so popup filter controls still receive styles.
- **Recommendation:** If a separate popup entrypoint is reintroduced, move filter styles to a popup CSS module. Not required now.

### 3. `SidePanelApp` `variant` prop defaults to `'sidepanel'`

- **File:** `src/sidepanel/SidePanelApp.tsx`
- **Impact:** Positive. The production entrypoint (`entrypoints/sidepanel/App.tsx`) does not pass `variant`, so the live Side Panel is controls-free by default. Only the test/legacy `PopupApp` opts into popup controls.

### 4. `git diff --check` clean

- No trailing whitespace or conflict markers introduced.

## Regression evidence

```text
/usr/local/bin/node ./node_modules/typescript/bin/tsc --noEmit   # pass
/usr/local/bin/node ./node_modules/vitest/vitest.mjs run          # 48 files, 1166 tests pass
/usr/local/bin/node ./node_modules/wxt/bin/wxt.mjs build          # pass
CI=true node ./node_modules/.pnpm/playwright@1.62.1/node_modules/playwright/cli.js test  # 11 pass
```

## Conclusion

Code quality is high. The only non-issues are intentionally retained utility formatters and CSS location choices that match the current entrypoint structure. No blocking issues.
