# Preference read ownership implementation plan

> **For agentic workers:** Use the executing-plans workflow task-by-task in this session. Steps use checkbox syntax for tracking.

**Goal:** Prevent superseded preference reads from rolling back the current locale, surface theme, settings, and annotations.

**Architecture:** Preserve existing readers and storage listeners. Assign a monotonically increasing request generation at read start and apply only the latest generation within the active effect. Locale selection also invalidates already-pending reads, preserving its immediate in-memory behavior. Settings/annotation reads remain a joint snapshot; a failed read keeps the last usable snapshot. No schema changes, new storage writes, extra polling, capture changes, or UI layout changes.

**Tech Stack:** React, TypeScript, LocalPreferences, Vitest, Testing Library.

**Boundaries:** This batch orders overlapping reads, not all reads against mutation acknowledgements. Existing serialized writes and pending-chain-write handling remain unchanged. Database scan budgets, translation scheduling, rendering optimization, Git operations, packaging, and installed-extension reload are outside this batch.

## Task 1: Preserve the newest locale decision

**Files:**
- Modify: `src/i18n/LocaleProvider.tsx`
- Test: `tests/unit/LocaleProvider.test.tsx`

- [x] Add deferred-read RED tests for old-after-new success, stale failure after newer success, and a pending read completing after manual locale selection.
- [x] Run `node node_modules/vitest/vitest.mjs run tests/unit/LocaleProvider.test.tsx --maxWorkers=1 --testTimeout=60000` and verify the assertions fail for locale rollback.
- [x] Add a shared `useRef(0)` generation; increment it at reload start and before manual selection. Keep the existing fallback and fire-and-forget writer.

```ts
const request = ++latestRead.current;
// Existing read and fallback resolution.
if (!disposed && request === latestRead.current) setLocale(next);
```

- [x] Add dependency-replacement/unmount checks and verify all locale tests pass without additional reads on manual selection.

## Task 2: Keep host chrome consistent with the newest theme

**Files:**
- Modify: `src/floatpanel/use-surface-theme.ts`
- Create test: `tests/unit/use-surface-theme.test.tsx`

- [x] Exercise the real hook with a real LocalPreferences instance whose asynchronous read boundary is deferred. Test old-after-new completion and a failed latest read followed by an older successful read.
- [x] Observe the old theme incorrectly committing before adding a guard.
- [x] Use effect-local ownership without changing listener registration or failure behavior:

```ts
let latestRequest = 0;
const reload = (): void => {
  const request = ++latestRequest;
  void preferences.getSettings().then((settings) => {
    if (!disposed && request === latestRequest) setTheme(settings.uiTheme);
  }).catch(() => {});
};
```

- [x] Verify dependency replacement, unmount cleanup, and unrelated/non-local storage changes.
- [x] Run `node node_modules/vitest/vitest.mjs run tests/unit/use-surface-theme.test.tsx tests/unit/LocaleProvider.test.tsx --maxWorkers=1 --testTimeout=60000`.

## Task 3: Protect the panel's joint preference snapshot

**Files:**
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Test: `tests/unit/SidePanelApp.test.tsx`

- [x] Extend the test storage boundary with real listener subscription/removal and an emitter. Inject a LocalPreferences instance and defer its reads; leave the real component and feed hook active.
- [x] Add RED tests proving an older joint read can revert both theme and annotation labels after the newest read commits; verify failed reads retain the current snapshot without an unhandled rejection.
- [x] Add effect-local `latestRequest`, capture it before `Promise.all`, and return when disposed or superseded. Catch both fire-and-forget reload entry points. Preserve the pending-chain-write check and filter ref updates.
- [x] Verify cleanup and dependency replacement, and run `node node_modules/vitest/vitest.mjs run tests/unit/SidePanelApp.test.tsx tests/unit/LocaleProvider.test.tsx tests/unit/use-surface-theme.test.tsx --maxWorkers=1 --testTimeout=60000`.

## Task 4: Integrated checkpoint

**Files:**
- Update: `docs/audits/2026-10-03-system-performance-and-fomo-capture.md`
- Update: this plan's checkboxes and checkpoint

- [x] Review the diff for ownership errors, unhandled rejections, and accidental writes, API changes, or layout changes.
- [x] Run the complete unit/integration suite with one worker, 60-second test timeout, and the unchanged Testing Library async timeout; save fresh JSON evidence to `.output/preference-ownership-results.json`.
- [x] Run `node node_modules/typescript/bin/tsc --noEmit`, `node node_modules/wxt/bin/wxt.mjs build`, and `git diff --check` after the final code/test change.
- [x] Record actual results and explicitly distinguish automated tests from browser validation. Leave main, releases, and installed extension untouched.

## Checkpoint

Baseline: the locale and side-panel test files passed 54 tests. The other two initially requested test paths did not exist; no extra test coverage is claimed for them.

Before the guards, deferred-read tests reproduced three locale rollbacks, two
theme rollbacks, two side-panel snapshot rollbacks, and two unhandled panel
read rejections. The selected suites now pass 67 tests across three files,
including replacement/unmount coverage and a nonempty annotation snapshot
retained after the latest annotation read fails and an older read succeeds.
Evidence: `.output/preference-ownership-targeted-results.json`.

Independent read-only review found no blocking issues. Its optional annotation
failure coverage suggestion was implemented and re-reviewed; no review items
remain open. After that final test addition, the full unit/integration suite
passed 1,881 tests across 102 files, with zero failed or skipped tests and exit
0. Type checking, the Chrome MV3 build (approximately 1.26 MB), and
`git diff --check` also passed. Evidence:
`.output/preference-ownership-results.json`.

Both test runs used one worker, a 60-second per-test timeout, and the unchanged
Testing Library async timeout. This is synthetic asynchronous-order coverage,
not real-browser latency profiling or installed-candidate validation. No Git
write, release, package replacement, or installed-extension reload occurred.
