# Feed render isolation implementation plan

> **For agentic workers:** Use the executing-plans workflow in this session, with a read-only code review at the checkpoint. Steps use checkbox syntax for tracking.

**Goal:** Stop diagnostics-only updates from recomputing unchanged cards without changing feed content, layout, persistence, or source/filter behavior.

**Architecture:** Memoize the existing presentational HistoryFeed with React's default shallow comparison, stabilize every callback passed by SidePanelApp, and move the one-second diagnostics clock into a diagnostics-only wrapper. Locale context, changed feed/settings/annotations, translation retry, pagination, and callbacks must still propagate. The wrapper mounts only inside the active Advanced settings tab. A 30-second clock bucket preserves quiet-feed timestamp updates through existing successful status polls, without adding a timer or query. No custom event comparator, viewport windowing, event identity reconciliation, per-second card refresh, or translation concurrency change is included.

**Review adjustment:** Initial shallow memoization froze quiet-feed timestamps. A real-card cross-minute regression reproduced this. The feed clock callback now changes only when an existing parent update observes a new 30-second bucket (or the injected clock changes). Successful status polls preserve the normal bounded cadence; failed requests and browser timer throttling do not guarantee wall-clock refresh, as before. Advanced diagnostics remain second-resolution, but no longer make feed labels second-resolution. Capture, read-marking, and mutation timestamps continue using the original clock.

**Tech Stack:** React, TypeScript, Vitest/jsdom, Testing Library, injected browser/storage boundaries.

**Baseline:** The four existing panel/feed/card/diagnostics suites pass 144 tests. Prior audit recorded 50 unchanged-card renders for a health update and a diagnostics tick. New tests will reproduce this through the real card's relative-time formatter, using a spy that calls the original implementation rather than substituting a card.

## Task 1: Reproduce unrelated card work and preserve invalidation paths

**Files:**
- Modify: `tests/unit/SidePanelApp.test.tsx`
- Create: `tests/unit/HistoryFeed-render-isolation.test.tsx`

- [x] Add 50 read-marked real trade rows through the existing panel harness. Spy on `formatRelativeTime` with its original implementation, clear mount calls, deliver `pipeline.healthChanged`, and require zero new calls while the diagnostic socket state still updates.
- [x] Repeat with omitted `deps.copyText` and `deps.openLink` to exercise production fallback callback identities, not just injected stable callbacks.
- [x] Advance the diagnostics clock while Advanced is visible and require updated diagnostic seconds with no card time-format calls. Verify no diagnostics timer while Display or Alerts is active, and no remaining timers on unmount.

```tsx
const formatTime = vi.spyOn(historyFormat, 'formatRelativeTime');
formatTime.mockClear();
act(() => harness.emit({ protocolVersion: 1, type: 'pipeline.healthChanged' }));
await act(async () => { await vi.advanceTimersByTimeAsync(100); });
expect(formatTime).not.toHaveBeenCalled();
```

- [x] Run `node node_modules/vitest/vitest.mjs run tests/unit/SidePanelApp.test.tsx --maxWorkers=1 --testTimeout=60000`; verify failures are repeated real-card computations or an unnecessary diagnostics timer.
- [x] Use the real LocaleProvider and HistoryFeed in the new test file. Verify unchanged props skip formatting, changed event/annotation/settings/retry-token props refresh the actual card, and manual locale changes update Buy/Sell labels despite unchanged feed props.

## Task 2: Isolate the feed with stable input identities

**Files:**
- Modify: `src/popup/HistoryFeed.tsx`
- Modify: `src/sidepanel/SidePanelApp.tsx`

- [x] Wrap the existing function with default React memo, without a custom comparator or markup changes. Stabilize the optional token-navigation fallback so direct/legacy consumers do not allocate one function per card.

```tsx
const ignoreTokenNavigation: NonNullable<HistoryFeedProps['onOpenToken']> = () => {};
export const HistoryFeed = memo(function HistoryFeed(props: HistoryFeedProps) {
  // Existing implementation, using onOpenToken ?? ignoreTokenNavigation.
});
```

- [x] Wrap existing `openLink` and `copyText` resolution in useCallback, depending on their respective injected callbacks. Keep default browser behavior unchanged.
- [x] Replace inline chain restoration with a stable callback that reads the current filter ref, preserving filters changed since the callback was created.

- [x] Preserve quiet-feed relative timestamps using a clock wrapper whose identity changes once per 30-second bucket. Test actual `just now` to `1m ago` progression with no events mutation, exactly one card computation per poll, no extra event query, and no additional timer.

```tsx
const selectAllChains = useCallback((): void => {
  handleFiltersChange({
    ...filtersRef.current,
    visibleChains: [...FILTERABLE_CHAINS],
  });
}, [handleFiltersChange]);
```

- [x] Run the scoped panel/feed/card suites. Verify changed dependencies still replace callbacks, Select all chains retains current action/amount filters, and existing pagination/note/translation tests remain green.

## Task 3: Localize diagnostics timing

**Files:**
- Modify: `src/sidepanel/PipelineDiagnostics.tsx`
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `tests/unit/PipelineDiagnostics.test.tsx`

- [x] Preserve the static PipelineDiagnostics API and add a live wrapper which owns only its clock:

```tsx
export function LivePipelineDiagnostics({ health, now }: PipelineDiagnosticsProps) {
  const [currentTime, setCurrentTime] = useState(() => now());
  useEffect(() => {
    setCurrentTime(now());
    const timer = setInterval(() => setCurrentTime(now()), 1_000);
    return () => clearInterval(timer);
  }, [now]);
  return <PipelineDiagnostics health={health} now={() => currentTime} />;
}
```

- [x] Remove the root's diagnostics clock state/effect/interval constant. Pass `health` and the stable `now` to LivePipelineDiagnostics through existing advancedContent; SettingsPanel already unmounts that content on inactive tabs.
- [x] Verify clock changes replace the live wrapper's timer, relative diagnostic labels use the new clock, and cleanup removes the timer. Keep static diagnostics tests timer-free.
- [x] Run `node node_modules/vitest/vitest.mjs run tests/unit/SidePanelApp.test.tsx tests/unit/HistoryFeed.test.tsx tests/unit/HistoryFeed-render-isolation.test.tsx tests/unit/EventCard.test.tsx tests/unit/PipelineDiagnostics.test.tsx --maxWorkers=1 --testTimeout=60000`.

## Task 4: Checkpoint and evidence

**Files:**
- Update: `docs/audits/2026-10-03-system-performance-and-fomo-capture.md`
- Update: this plan

- [x] Review shallow-memo invalidation and lifecycle ownership, including locale context, translation retry, dependency replacement, and current filters. Obtain read-only review without unrelated edits.
- [x] Run the full unit/integration suite with one worker, a 60-second test timeout, and the unchanged Testing Library async timeout; save `.output/render-isolation-results.json`.
- [x] Run `node node_modules/typescript/bin/tsc --noEmit`, `node node_modules/wxt/bin/wxt.mjs build`, and `git diff --check` after the final code/test change.
- [x] Document actual repeated-computation reduction, not live-browser latency claims. Leave main, installed extension, ZIPs, and releases unchanged. No Git commit, merge, or push is authorized.

## Deferred work

Per-card memoization and immutable row identity reconciliation need a separate
invalidation contract. Physical scan budgets, translation concurrency,
viewport windowing, and real-browser profiling remain outside this batch.
