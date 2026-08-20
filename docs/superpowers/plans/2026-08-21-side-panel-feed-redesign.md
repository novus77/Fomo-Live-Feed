# Side Panel Feed Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the toolbar Popup with a persistent Chrome Side Panel, compress filtering, add actionable chain/CA metadata, and make delayed or missing Fomo activity observable without storing sensitive payloads.

**Architecture:** The existing WebSocket → bridge → worker → IndexedDB pipeline remains authoritative. A new bounded health projection records only counters, timestamps, and closed-set rejection codes in `chrome.storage.session`; the Side Panel queries that projection and the existing event repositories. Existing Popup React components are migrated into a responsive Side Panel shell, while in-page Toast delivery remains unchanged.

**Tech Stack:** WXT 0.21.x, Chrome Manifest V3 Side Panel API, React 19, TypeScript 5.x, Zod 4, Dexie 4, Vitest, Testing Library, Playwright.

---

## Scope and constraints

- Chrome 114+ only for this release.
- Remove the full Popup entrypoint; do not maintain two history UIs.
- Preserve the supported-site Toast stack.
- Add only the `sidePanel` extension permission. Do not add `<all_urls>`,
  `cookies`, or broad `scripting` permission.
- Do not implement REST backfill in this plan. The plan adds evidence needed to
  decide whether backfill is necessary and safe.
- Do not log or persist raw WebSocket frames, cookies, headers, tokens, wallet
  balances, theses, addresses, or arbitrary URLs in diagnostics.
- Keep existing IndexedDB and `chrome.storage.local` schemas compatible.

## Planned file changes

```text
entrypoints/
  sidepanel/
    index.html                         New WXT Side Panel entrypoint
    main.tsx                           React bootstrap
    App.tsx                            Browser dependency injection
    sidepanel.css                      Responsive panel presentation
  popup/                               Remove after Side Panel parity
  background.ts                       Side Panel behavior + health routing
src/
  background/
    pipeline-health.ts                 Bounded persisted health projection
    ingest-activity.ts                 Health hooks around ingest outcomes
  fomo/
    websocket-observer.ts              Observer/socket/frame health signals
    bridge.ts                          Forward validated health signals
  messaging/
    protocol.ts                        Versioned health messages/query response
    guards.ts                          Sender rules for health messages
  sidepanel/
    SidePanelApp.tsx                   Main panel composition root
    ConnectionIndicator.tsx            Permanent five-state indicator
    FilterToolbar.tsx                  Compact toolbar/popover/chips
    ChainBadge.tsx                     Accessible chain presentation
    EventCard.tsx                      Side Panel event card + CA row
    CopyableAddress.tsx                Clipboard feedback component
    pipeline-health-view.ts            Safe health view model
  popup/                               Reuse pure feed/settings modules, then rename
tests/
  unit/
  integration/
  e2e/
docs/
  manual-testing.zh-CN.md
  development.md
  privacy.md
```

### Task 1: Add a bounded, redacted pipeline-health projection

**Files:**
- Create: `src/background/pipeline-health.ts`
- Modify: `src/background/ingest-activity.ts`
- Modify: `src/background/diagnostics.ts`
- Modify: `src/messaging/protocol.ts`
- Modify: `src/messaging/guards.ts`
- Modify: `entrypoints/background.ts`
- Test: `tests/unit/pipeline-health.test.ts`
- Test: `tests/unit/ingest-activity.test.ts`
- Test: `tests/unit/messaging.test.ts`

- [ ] **Step 1: Write failing health-state tests**

Add tests for initial state, monotonic counters, timestamp updates, rejection
codes, serialization, malformed session state, and sensitive-key rejection:

```ts
expect(new PipelineHealthState(() => 1_000).snapshot()).toEqual({
  schemaVersion: 1,
  observerInstalled: false,
  socketObserved: false,
  socketOpen: false,
  activityCandidates: 0,
  accepted: 0,
  rejected: 0,
  duplicates: 0,
  persisted: 0,
  broadcasts: 0,
});

health.record({ type: 'activity.rejected', code: 'schema_invalid', at: 2_000 });
expect(health.snapshot()).toMatchObject({
  rejected: 1,
  lastRejectionCode: 'schema_invalid',
  lastRejectedAt: 2_000,
});
```

The persisted schema must reject extra keys such as `payload`, `cookie`,
`tokenAddress`, `thesis`, `url`, or `headers`.

- [ ] **Step 2: Verify the tests fail**

Run:

```bash
corepack pnpm vitest run tests/unit/pipeline-health.test.ts tests/unit/ingest-activity.test.ts tests/unit/messaging.test.ts
```

Expected: FAIL because `PipelineHealthState` and health protocol messages do
not exist.

- [ ] **Step 3: Implement the closed health model**

Use these public types:

```ts
export type PipelineRejectionCode =
  | 'schema_invalid'
  | 'duplicate'
  | 'storage_failed'
  | 'broadcast_failed';

export interface PipelineHealthSnapshotV1 {
  schemaVersion: 1;
  observerInstalled: boolean;
  socketObserved: boolean;
  socketOpen: boolean;
  lastFrameAt?: number;
  lastCandidateAt?: number;
  lastPersistedAt?: number;
  latestEventOccurredAt?: number;
  activityCandidates: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  persisted: number;
  broadcasts: number;
  lastRejectionCode?: PipelineRejectionCode;
  lastRejectedAt?: number;
}
```

Persist under `pipelineHealth.v1` in `chrome.storage.session`. Validate every
timestamp as a finite non-negative integer and every counter as a bounded
non-negative safe integer. Saturate counters at `Number.MAX_SAFE_INTEGER`.

- [ ] **Step 4: Add protocol messages and worker routing**

Add:

```ts
| { protocolVersion: 1; type: 'pipeline.healthEvent'; payload: PipelineHealthEvent }
| { protocolVersion: 1; type: 'pipeline.healthQuery' }
```

Only Fomo content scripts may send `pipeline.healthEvent`; only extension
pages may send `pipeline.healthQuery`. The query response is
`{ ok: true, health: PipelineHealthSnapshotV1 }`.

Wire ingest results so accepted, duplicate, persisted, rejected, and broadcast
outcomes update the projection exactly once.

- [ ] **Step 5: Run verification and commit**

Run:

```bash
corepack pnpm vitest run tests/unit/pipeline-health.test.ts tests/unit/ingest-activity.test.ts tests/unit/messaging.test.ts
corepack pnpm typecheck
```

Expected: focused tests and typecheck pass.

```bash
git add src/background src/messaging entrypoints/background.ts tests/unit/pipeline-health.test.ts tests/unit/ingest-activity.test.ts tests/unit/messaging.test.ts
git commit -m "feat: expose redacted pipeline health"
```

### Task 2: Detect observer readiness and pre-existing socket risk

**Files:**
- Modify: `src/fomo/websocket-observer.ts`
- Modify: `src/fomo/bridge.ts`
- Modify: `entrypoints/fomo-interceptor.content.ts`
- Test: `tests/unit/fomo-interceptor.test.ts`
- Test: `tests/integration/fomo-bridge.test.ts`

- [ ] **Step 1: Write failing observer-health tests**

Verify:

```ts
expect(events).toContainEqual({ type: 'observer.installed' });
expect(events).toContainEqual({ type: 'socket.observed', at: NOW });
expect(events).toContainEqual({ type: 'socket.opened', at: NOW });
expect(events).toContainEqual({ type: 'frame.received', at: NOW });
expect(events).toContainEqual({ type: 'activity.candidate', at: NOW });
```

Also verify non-Fomo sockets never set `socketObserved`, non-string/binary
frames only update frame count when they belong to the Fomo socket, and no
health envelope contains the raw frame.

- [ ] **Step 2: Verify red**

Run:

```bash
corepack pnpm vitest run tests/unit/fomo-interceptor.test.ts tests/integration/fomo-bridge.test.ts
```

Expected: FAIL because observer-health events are absent.

- [ ] **Step 3: Emit and bridge health events**

Extend the existing namespaced `window.postMessage` protocol with a closed
`pipeline.healthCandidate` envelope. Emit only the event type and current
timestamp. The isolated bridge validates it and forwards
`pipeline.healthEvent` to the worker.

On installation, emit `observer.installed`. On constructing a matching Fomo
socket emit `socket.observed`; open/close update socket state; every inbound
Fomo frame updates `lastFrameAt`; accepted topic frames increment candidate
count.

- [ ] **Step 4: Add refresh-guidance derivation**

Create a pure predicate in `src/sidepanel/pipeline-health-view.ts`:

```ts
export const needsFomoRefresh = (input: {
  hasFomoTab: boolean;
  observerInstalled: boolean;
  socketObserved: boolean;
  connected: boolean;
}): boolean =>
  input.hasFomoTab &&
  input.observerInstalled &&
  !input.socketObserved &&
  !input.connected;
```

This state asks the user to refresh; it never triggers automatic reload.

- [ ] **Step 5: Verify and commit**

Run focused tests and `corepack pnpm typecheck`.

```bash
git add src/fomo src/sidepanel/pipeline-health-view.ts entrypoints/fomo-interceptor.content.ts tests/unit/fomo-interceptor.test.ts tests/integration/fomo-bridge.test.ts
git commit -m "feat: detect Fomo observer readiness"
```

### Task 3: Migrate the extension action from Popup to Side Panel

**Files:**
- Create: `entrypoints/sidepanel/index.html`
- Create: `entrypoints/sidepanel/main.tsx`
- Create: `entrypoints/sidepanel/App.tsx`
- Create: `entrypoints/sidepanel/sidepanel.css`
- Create: `src/sidepanel/sidepanel-api.ts`
- Modify: `entrypoints/background.ts`
- Modify: `wxt.config.ts`
- Remove: `entrypoints/popup/index.html`
- Remove: `entrypoints/popup/main.tsx`
- Remove: `entrypoints/popup/App.tsx`
- Remove: `entrypoints/popup/popup.css`
- Test: `tests/unit/sidepanel-api.test.ts`
- Modify: `tests/unit/smoke.test.ts`

- [ ] **Step 1: Write failing Side Panel configuration tests**

Test a feature-detected wrapper:

```ts
await configureActionSidePanel({
  sidePanel: { setPanelBehavior },
});
expect(setPanelBehavior).toHaveBeenCalledWith({ openPanelOnActionClick: true });
```

The missing-API case returns `{ supported: false }` without throwing.

- [ ] **Step 2: Verify red**

Run:

```bash
corepack pnpm vitest run tests/unit/sidepanel-api.test.ts tests/unit/smoke.test.ts
```

Expected: FAIL because no Side Panel entrypoint or wrapper exists.

- [ ] **Step 3: Add WXT Side Panel entrypoint**

`entrypoints/sidepanel/index.html` contains `#root`; `main.tsx` mounts the
injected `App`; `App.tsx` supplies the same runtime/storage/clock/navigation/
clipboard dependencies used by the old Popup.

Update manifest configuration:

```ts
manifest: {
  minimum_chrome_version: '114',
  permissions: ['storage', 'sidePanel'],
  // existing explicit host_permissions unchanged
}
```

Call `configureActionSidePanel` during worker bootstrap. Remove the Popup
entrypoint so WXT no longer generates `action.default_popup`.

- [ ] **Step 4: Verify the production manifest**

Run:

```bash
corepack pnpm build
node -e "const m=require('./.output/chrome-mv3/manifest.json'); if(m.action?.default_popup) process.exit(1); if(m.side_panel?.default_path!=='sidepanel.html') process.exit(1); if(!m.permissions.includes('sidePanel')) process.exit(1)"
```

Expected: Side Panel path exists, no Popup path exists, and permissions are
exactly `storage` plus `sidePanel`.

- [ ] **Step 5: Commit**

```bash
git add entrypoints src/sidepanel/sidepanel-api.ts wxt.config.ts tests/unit/sidepanel-api.test.ts tests/unit/smoke.test.ts
git commit -m "feat: migrate feed to Chrome side panel"
```

### Task 4: Build the Side Panel shell and permanent status header

**Files:**
- Create: `src/sidepanel/SidePanelApp.tsx`
- Create: `src/sidepanel/ConnectionIndicator.tsx`
- Move/Modify: `src/popup/PopupApp.tsx` responsibilities into `src/sidepanel/SidePanelApp.tsx`
- Modify: `entrypoints/sidepanel/App.tsx`
- Modify: `entrypoints/sidepanel/sidepanel.css`
- Modify: `src/popup/ConnectionBanner.tsx`
- Test: `tests/unit/SidePanelApp.test.tsx`
- Test: `tests/unit/ConnectionIndicator.test.tsx`

- [ ] **Step 1: Write failing header/state tests**

Parameterize all states:

```ts
it.each([
  ['loading', 'Checking…'],
  ['connected', 'Connected'],
  ['reconnecting', 'Reconnecting'],
  ['offline', 'Offline'],
  ['login-required', 'Login required'],
] as const)('renders %s as %s', async (state, label) => {
  render(<ConnectionIndicator state={state} />);
  expect(screen.getByRole('status')).toHaveTextContent(label);
});
```

Test live `connection.changed` and 30-second re-query transitions.

- [ ] **Step 2: Write failing gear-button tests**

Assert the header contains no visible `Settings` text, includes a local SVG,
has `aria-label="Settings"`, toggles the existing settings panel, and retains
keyboard focus styles.

- [ ] **Step 3: Implement the responsive shell**

Move composition state/hooks from `PopupApp` without changing repository or
protocol behavior. Side Panel root uses `width: 100%`, `min-width: 280px`,
and viewport-height layout instead of the Popup's fixed `380×560` box.

Render refresh guidance when `needsFomoRefresh(...)` is true. Include an
`Open Fomo` action and text asking for a manual refresh; never call
`tabs.reload`.

- [ ] **Step 4: Verify and commit**

Run Side Panel component tests, all existing history/settings tests, and
typecheck.

```bash
git add src/sidepanel src/popup/ConnectionBanner.tsx entrypoints/sidepanel tests/unit/SidePanelApp.test.tsx tests/unit/ConnectionIndicator.test.tsx tests/unit/HistoryFeed.test.tsx tests/unit/SettingsPanel.test.tsx
git commit -m "feat: add responsive side panel shell"
```

### Task 5: Replace the filter block with a toolbar, popover, and chips

**Files:**
- Create: `src/sidepanel/FilterToolbar.tsx`
- Create: `src/sidepanel/ActiveFilterChips.tsx`
- Modify: `src/popup/FilterBar.tsx` or remove after migration
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `entrypoints/sidepanel/sidepanel.css`
- Test: `tests/unit/FilterToolbar.test.tsx`
- Test: `tests/unit/event-query.test.ts`

- [ ] **Step 1: Write failing toolbar/chip tests**

Cover:

- Search always visible.
- One compact row contains Filters, Unread, Pinned, and conditional Reset.
- Filters opens the four-select popover.
- Active count excludes search and pinned ordering but includes unread/action/
  chain/trader/token.
- Chips remove only their own filter.
- Reset restores `DEFAULT_FILTERS` and `pinnedFirst=false`.
- Escape/outside click closes and focus returns to Filters.

- [ ] **Step 2: Verify red**

Run:

```bash
corepack pnpm vitest run tests/unit/FilterToolbar.test.tsx tests/unit/event-query.test.ts
```

- [ ] **Step 3: Implement controlled components**

Use existing `PopupEventFilters`, `PopupTraderOption`, and `PopupTokenOption`.
Do not duplicate query logic. Public callbacks:

```ts
interface FilterToolbarProps {
  filters: PopupEventFilters;
  pinnedFirst: boolean;
  traders: readonly PopupTraderOption[];
  tokens: readonly PopupTokenOption[];
  onFiltersChange(next: PopupEventFilters): void;
  onPinnedFirstChange(next: boolean): void;
}
```

Use semantic buttons, labels, and a popover dialog with focus management; no
new UI dependency.

- [ ] **Step 4: Verify and commit**

Run focused tests, all Side Panel/history tests, and typecheck.

```bash
git add src/sidepanel src/popup/FilterBar.tsx entrypoints/sidepanel/sidepanel.css tests/unit/FilterToolbar.test.tsx tests/unit/event-query.test.ts
git commit -m "feat: compact side panel filters"
```

### Task 6: Add accessible chain badges and full copyable CA rows

**Files:**
- Create: `src/sidepanel/chain-presentation.tsx`
- Create: `src/sidepanel/ChainBadge.tsx`
- Create: `src/sidepanel/CopyableAddress.tsx`
- Create/Modify: `src/sidepanel/EventCard.tsx`
- Modify: `src/overlay/ToastStack.tsx`
- Modify: `entrypoints/sidepanel/sidepanel.css`
- Test: `tests/unit/ChainBadge.test.tsx`
- Test: `tests/unit/CopyableAddress.test.tsx`
- Modify: `tests/unit/HistoryFeed.test.tsx`

- [ ] **Step 1: Write failing chain-presentation tests**

For every `ChainKey`, assert a non-empty label, local SVG, CSS token, and
accessible text. Unknown renders `Unknown`; no remote image URL is present.

- [ ] **Step 2: Write failing CA behavior tests**

Assert:

```ts
expect(screen.getByText(/^CA:/)).toBeInTheDocument();
expect(screen.getByText(FULL_ADDRESS)).toBeVisible();
await user.click(screen.getByRole('button', { name: /copy contract address/i }));
expect(copyText).toHaveBeenCalledWith(FULL_ADDRESS);
expect(await screen.findByRole('status')).toHaveTextContent('Copied');
expect(openLink).not.toHaveBeenCalled();
```

Add copy failure and invalid/unknown-chain selectable-text cases.

- [ ] **Step 3: Implement centralized presentation and card layout**

`chain-presentation.tsx` is the only chain icon/color map. Use inline local
SVG components with `aria-hidden`; `ChainBadge` supplies visible text.

`CopyableAddress` renders full canonical text, permits wrapping and selection,
copies on address or icon click, stops propagation, and announces success or
failure. Invalid addresses remain visible but have no trusted navigation.

Use the same `ChainBadge` in Toast and Side Panel so presentation cannot drift.

- [ ] **Step 4: Verify and commit**

Run the three focused suites, Toast tests, typecheck, and build.

```bash
git add src/sidepanel src/overlay/ToastStack.tsx entrypoints/sidepanel/sidepanel.css tests/unit/ChainBadge.test.tsx tests/unit/CopyableAddress.test.tsx tests/unit/HistoryFeed.test.tsx tests/unit/ToastStack.test.tsx
git commit -m "feat: add chain badges and copyable contract addresses"
```

### Task 7: Prove multi-message delivery and expose safe diagnostics

**Files:**
- Create: `src/sidepanel/PipelineDiagnostics.tsx`
- Modify: `src/sidepanel/SidePanelApp.tsx`
- Modify: `src/background/pipeline-health.ts`
- Modify: `src/background/ingest-activity.ts`
- Test: `tests/unit/PipelineDiagnostics.test.tsx`
- Test: `tests/integration/fomo-bridge.test.ts`
- Test: `tests/unit/ingest-activity.test.ts`
- Test: `tests/unit/popup-worker-boundary.test.ts`

- [ ] **Step 1: Write failing multi-message pipeline tests**

Send five distinct valid frames and one duplicate through the real observer →
bridge → worker boundary. Assert five persisted rows, five broadcasts, one
duplicate, newest event timestamp, and no raw values in the health snapshot.

Add a rejected-schema frame and assert the closed rejection code increments
without storing its payload.

- [ ] **Step 2: Write failing diagnostics UI tests**

Diagnostics in Settings renders status values and counts, never raw activity.
It shows:

- Observer ready/not ready.
- Socket observed/open.
- Last frame and persisted relative times.
- Candidate/accepted/rejected/duplicate/persisted/broadcast counts.
- Last closed rejection label.

- [ ] **Step 3: Implement diagnostics UI and consistency checks**

Query through `pipeline.healthQuery`; do not give the Side Panel direct access
to session storage. Refresh on health-change messages and at a bounded
30-second interval.

If `accepted > persisted` or `persisted > broadcasts`, display a neutral
pipeline warning identifying the stage, not the underlying activity fields.

- [ ] **Step 4: Run verification and commit**

Run focused/integration tests, `corepack pnpm check`, and confirm 752 existing
tests plus the new tests pass.

```bash
git add src/sidepanel/PipelineDiagnostics.tsx src/sidepanel/SidePanelApp.tsx src/background tests/unit/PipelineDiagnostics.test.tsx tests/integration/fomo-bridge.test.ts tests/unit/ingest-activity.test.ts tests/unit/popup-worker-boundary.test.ts
git commit -m "feat: diagnose delayed Fomo activity"
```

### Task 8: Update E2E coverage, release checks, and testing documentation

**Files:**
- Modify: `tests/e2e/live-feed.spec.ts`
- Modify: `tests/e2e/fixture-server.ts`
- Modify: `docs/manual-testing.zh-CN.md`
- Modify: `docs/development.md`
- Modify: `docs/privacy.md`
- Modify: `README.md`
- Modify: `docs/superpowers/plans/2026-08-21-side-panel-feed-redesign.md`

- [ ] **Step 1: Replace Popup E2E with real Side Panel E2E**

Use CDP/Chrome extension APIs to open the action Side Panel. Verify:

- `sidepanel.html` loads as an extension page.
- Search/filter/history render.
- Five fixture events produce five history rows and at most three in-page
  Toasts.
- Chain badges and full CA appear.
- Copy action does not navigate.
- Connection and diagnostics state update.

- [ ] **Step 2: Add manifest assertions**

Assert:

```ts
expect(manifest.action?.default_popup).toBeUndefined();
expect(manifest.side_panel?.default_path).toBe('sidepanel.html');
expect(manifest.minimum_chrome_version).toBe('114');
expect(manifest.permissions?.sort()).toEqual(['sidePanel', 'storage']);
expect(manifest.host_permissions).toEqual(EXPECTED_EXPLICIT_HOSTS);
```

- [ ] **Step 3: Update documentation**

Document Side Panel installation/opening, compact filters, chain/CA checks,
observer refresh guidance, diagnostics interpretation, and the fact that REST
backfill remains disabled pending authenticated evidence. Update privacy text
for the closed health projection stored in `chrome.storage.session`.

- [ ] **Step 4: Run the full release gate**

Run:

```bash
corepack pnpm check
corepack pnpm test:e2e
git diff --check
git status --short
```

Expected: all unit/integration tests, typecheck, production build, and Side
Panel E2E pass; diff check is clean; only intentional documentation-plan
checkbox edits remain before commit.

- [ ] **Step 5: Commit the completed redesign**

Mark every completed checkbox in this plan, then commit:

```bash
git add tests/e2e docs README.md
git commit -m "test: verify side panel feed redesign"
```

## Manual release checkpoint

After Task 8, load `.output/chrome-mv3` in stable Chrome and execute the
updated Chinese manual test guide. The release is blocked until:

1. A Fomo tab refreshed after extension load reports observer ready and socket
   open.
2. At least five real followed-trader activities are compared against Fomo and
   appear in the Side Panel within seconds.
3. Any missing activity is localized by counter divergence or a closed
   rejection code.
4. Side Panel, Toasts, filters, chain badges, CA copy, settings, reconnect, and
   browser restart pass.
5. No REST recovery source is enabled without a redacted authenticated fixture
   and separate approval.

