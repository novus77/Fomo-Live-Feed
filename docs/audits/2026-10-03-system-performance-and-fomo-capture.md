# System performance, UX, and Fomo capture audit

Date: 2026-10-03 (Asia/Shanghai)

## Scope and baseline

The audit covers Fomo capture, Pump polling, ingestion, IndexedDB persistence,
retention, feed queries, React rendering, translation sessions, and surface
handoff. The baseline is release v0.6.1, commit `c29f48b`, with the pending
English DOM-fallback repair preserved in `codex/english-fomo-fallback`.

This is a local candidate, not a released version. No account preferences,
transactions, history migrations, schema versions, or GitHub releases are
changed. Findings below distinguish executable reproductions, browser
observations, and optimization proposals that still need profiling.

## Architecture

```text
Fomo page traffic / DOM fallback -> isolated bridge -> activity ingestion
Pump page polling / lease       -> batch bridge    -> activity ingestion
                                                       |
                                          validation / normalization
                                                       |
                                         IndexedDB events + aliases
                                                       |
                                          events.changed -> feed query
                                                       |
                                            Side Panel / PiP cards
                                                       |
                                      Fomo-hosted local translation
```

The existing architecture already provides bounded payload validation,
source-aware stable identities, Pump backoff/catch-up, incremental database
cleanup, local settings, and a single active presentation surface. The main
weak points are lifecycle coordination and repeated work, rather than a need
to replace the architecture.

## Reproduced correctness issues addressed in this candidate

| Issue | Reproduction | Correction |
| --- | --- | --- |
| Pump checkpoint advances beyond persisted chunks | Catch up 101 trades, commit only the first 100, restart the worker with its checkpoint; the missing trade is already marked seen | Send chunks sequentially; intermediate checkpoints contain only acknowledged progress, and the final chunk commits the complete watermark |
| Retention leaves orphan aliases | Persist a trade, expire it, replay it; insertion throws `ConstraintError` because its alias remains | Delete selected events and their aliases atomically; lazily repair pre-existing orphan aliases during persistence |
| Retention runs concurrently | Two calls enter before the last-run timestamp is updated | Share one in-flight cleanup promise |
| Live refresh invalidates history pagination | Deliver `events.changed` while a history page is pending | Coalesce live refresh until that page commits, preserving its cursor and results |
| A stale refresh releases a newer request's state | Replace filters/annotations while a head query is pending, then finish the old query during a newer head query or history page | Only the owning generation releases shared refresh state; full reload takes ownership, and effect cleanup releases only its own lock |
| Surface handoff destroys another client's translator | Host and PiP share a language-pair session; host cleanup destroys the session used by PiP | Track client-owned session leases; dispose only after the final lease is released |
| DOM fallback selects an avatar as a token image | A current Fomo transaction anchor contains the avatar first and the token image later; trader names can equal the ticker | Prefer marked semantic token labels and adjacent thumbnails, exclude profile images, and never substitute an avatar for a missing thumbnail |
| DOM hydration waits for the periodic scan | Add text inside an already-created transaction anchor | Inspect the containing transaction anchor on child-list changes |
| Trillion-scale market cap is misread | The live page displays `$1.20万亿`; the parser returns `12000` | Recognize `万亿` and `T` before shorter units; retain the full scale |
| Disabled fallback still walks mutation batches | Authoritative capture is active while the trading page mutates frequently | Exit before traversing the mutation batch |
| Invalid candidate disables fallback | A valid envelope carries `null`, `{}`, or a malformed timestamp | Only upgrade activity-derived connection state after shared raw-schema validation; retain background rejection handling |
| Reused XHR leaks request listeners | Reuse one XHR for feed, unrelated, then feed; previous listeners observe later responses | Bind observation to the current request and use a one-shot listener |
| Fetch size limit applies after full allocation | An oversized streaming response is cloned and fully read before its size is checked | Count bytes while reading and cancel the observation branch at the limit without awaiting the page's branch |

Existing retention limits and cleanup batch sizes are intentionally unchanged.
No stored ticker is rewritten: contaminated historical text does not contain
enough trustworthy information to reconstruct the original symbol.

## Performance findings and next-stage priorities

### 1. Query work needs a physical scan budget

`EventRepository.page` limits matched results, not rows examined. A synthetic
20,000-row database with one unread event examines/deserializes 20,000 rows for
`page({ limit: 50, unreadOnly: true })`. The higher-level ten-page limit does
not bound this internal scan. The repository only retains matching results;
this is a scan-work finding, not a claim that it retains a 20,000-object array.

Recommended next change: add an examined-row budget and an explicit resumable
cursor for sparse queries, or add targeted indexes after measuring common
filter combinations. Keep `hasMore` and `scanExceeded` distinct. Test sparse
source, unread, action, chain, and amount filters on 20,000 rows.

### 2. Empty sparse-filter results need a continuation action

`HistoryFeed` returns its empty-state branch before rendering pagination.
When the scan budget is exhausted with no visible matches, users cannot reach
matching records deeper in history even if `hasMore` is true.

Recommended next change: preserve a bounded "Continue searching history"
action in the scan-exceeded empty state. Test 500 nonmatching Fomo events
followed by a matching Pump event. Do not automatically scan the full history.

Follow-up checkpoint: implemented using the existing load-more button and
localized labels. Ten requests examine the first 500 nonmatching rows, stop
without automatic continuation, and a click resumes from the existing cursor
to reveal the Pump row. Loading, exhausted, initial/error, and all-chains-off
states are covered. The physical database-scan issue above remains separate.

### 3. Separate diagnostics from feed rendering

A React/jsdom probe with 50 real `EventCard` components observed 50 card
renders for a health-only update and 50 for a settings diagnostics tick with
unchanged card data. This demonstrates redundant renders, not a measured
real-browser frame-time regression.

Recommended next change: isolate the diagnostics ticker, preserve unchanged
event object identities, and memoize cards with stable callbacks. Benchmark
1,000 and 5,000 loaded rows before introducing viewport windowing. Pagination
currently controls page size, not the maximum number of mounted cards.

### 4. Batch noncritical ingestion side effects

A synthetic 100-event ingestion run produced 300 health-storage writes and
100 change broadcasts. Pump batch ingestion also refreshes the unread badge
per event, including database counts and browser action calls.

Recommended next change: keep each event's durable persistence and deduplication
semantics, but coalesce health snapshots, badge refreshes, and change signals
at explicit batch boundaries. Flush pending state on
lifecycle boundaries; never acknowledge Pump progress before event persistence.

Follow-up checkpoint: Pump badge refresh now occurs once at batch completion,
including partial-failure cleanup. A 100-insert worker-boundary test preserves
100 stored rows and 100 `events.changed` broadcasts while reducing unread-count
queries and badge text/color updates from 100 pairs to one pair. This is a
verified reduction in repeated operations, not a measured live latency gain.
Health snapshot writes and per-event broadcasts are deliberately unchanged.

### 5. Retention is a soft target, not a strict capacity bound

One cleanup run deletes at most 500 records and normal scheduling is every
six hours. More than 2,000 retained events per day, or a large pre-existing
backlog, can outpace cleanup. The previous documentation's strict "30 days or
20,000" wording was stronger than the implementation; README and privacy
documentation now describe incremental cleanup targets and possible backlog.

Recommended next decision: drain a backlog in bounded, scheduled
continuations if strict capacity behavior is required. Increasing
deletion throughput changes the effective retention behavior and is not part
of this local repair batch.

### 6. Bound translation work to useful content

Each mounted opinion can trigger detection, availability, and translation
round trips, and different texts have no global concurrency limit. Native
overload has not been measured here.

Recommended next change: queue translations with a small concurrency limit,
prioritize visible/new opinions, cancel stale requests, and make unavailable,
activation-required, and retryable failure states actionable.

Client leases fix normal surface handoff, not every transport failure. A
successful create whose reply is lost, or an abrupt client exit without
destroy delivery, can leave a lease until the Fomo host is disposed. A future
lease-expiry/disconnect design needs explicit ownership and retry semantics;
the current repair does not claim to eliminate all native-session leaks.

### 7. Preserve native WebSocket listener options

The currently unused listener-based observer omits the third
`addEventListener` argument. A `once: true` reproduction invokes the listener
twice. It must forward `once`, `capture`, and `signal` before that alternate
observer is enabled. The current entry point does not use this variant.

### 8. Guard asynchronous settings reads by request ownership

Deferred-read regressions confirmed that `SidePanelApp` settings/annotation
reloads, `use-surface-theme`, and `LocaleProvider` previously checked disposal
but not whether a newer read had started. An older read completing last could
replace newer UI preferences and trigger another feed reload. A stale locale
read failure could also apply its fallback over a newer locale, and a pending
read could override manual language selection. Persistent settings are not
rewritten by these reads. Panel read failures also produced unhandled promise
rejections at both mount and storage-change entry points.

Follow-up checkpoint: latest-started-request guards now protect all three
readers. Manual language selection invalidates already-pending locale reads.
Panel reads still apply settings and annotations together; failure keeps the
last usable snapshot and does not release an older request to commit. Tests
cover cross-surface notifications, old-after-new success/failure, dependency
replacement, listener cleanup, and a nonempty annotation snapshot surviving a
newer annotation read failure. This is read ordering, not a general ordering
protocol for reads versus mutation acknowledgements. Existing serialized
writes and pending chain-write protection are unchanged. Write serialization
alone does not order independent readers.

### 9. Align installation guidance with the manifest

`wxt.config.ts` requires Chrome 141 for `SidePanel.close`, while the local ZIP
guide and development prerequisites still say Chrome 138. This is a confirmed
documentation mismatch, not a regression in native API support. The guide's
existing unit test also asserts the outdated number.

Recommended next change before packaging: derive or validate the guide's
minimum version against the built manifest and update the prerequisites/test.
The Chrome 138 introduction date of on-device translation is a separate fact
and must not be treated as the extension's installation requirement.

Follow-up checkpoint: the local installer guide and development prerequisites
now require Chrome 141. A regression test compares the guide's minimum against
`minimum_chrome_version` in `wxt.config.ts`; no manifest or package version was
changed.

## Current Fomo page observations

The user's authenticated Chrome Fomo token page was inspected through native
browser UI, without reading credentials or sending new authenticated API
requests. The official public site is [fomo.family](https://fomo.family/).

Observed transaction structure:

```html
<a href="/tokens/solana/<mint>?tradeId=<stable-id>">
  <div role="link"><img src="<trader-avatar>"></div>
  <div>
    <div role="link"><div translate="no"><div>Trader</div></div></div>
    <div>Buy</div><span><span title="<absolute-time>">1m</span></span>
    <div>
      <div><img src="<token-thumbnail>"></div>
      <div role="link" translate="no">TOKEN</div>
      <span>$100</span><span>at</span><span>$175K</span><span>MC</span>
    </div>
  </div>
</a>
```

The observed UI was Chinese; English labels in this redacted structure are
synthetic translations, not an English live capture. Live `innerText` separates
fields with newlines, while `textContent` concatenates them. The outer trading
anchor has no `title`; title-only fixtures must not be treated as proof of the
current DOM. A token label may be a `div[role="link"]`, not a nested anchor.
Opinion cards have a different layout and remain distinct from buy/sell rows.

The page showed a frontend update notification. Reloading restored the token
page with new feed rows and the same activity/thumbnail structure. One row
displayed a `万亿` market cap. The update notification remained visible, so
no exact frontend build/version is claimed. Before reload, chart prices were
updating while the visible notification feed aged; that symptom warrants
isolated connection monitoring, not a conclusion that the plugin caused it.

Compatibility constraints retained:

- Require a stable `tradeId` for DOM transaction persistence.
- Keep raw fallback text away from unrelated chart/trading controls.
- Preserve source/chain filtering, event market cap, and trade amounts.
- Prefer authoritative traffic capture; use DOM only as fallback.
- Text-node-only (`characterData`) hydration still relies on the existing
  two-second scan; immediate mutation handling is limited to child-list changes.
- Avoid treating missing thumbnails as transaction failures.
- Do not infer a new chain or API field from an unrelated token-detail page.

Limitations and operational observations:

- Only BSC was enabled in the extension's chain filter (`1/7`). A quiet visible
  feed is not proof that Solana or Robinhood ingestion has stopped.
- Another Fomo extension was active. DevTools showed many 429/401 requests and
  diagnostics from that extension. These requests are not attributable to
  this plugin without an isolated request initiator capture.
- Chrome's high-memory labels apply to whole tabs, including Fomo charts and
  other extensions, not specifically to this plugin.
- A 20-second bounded listener observed zero `fomo-live-feed` activity candidates.
  It does not establish transport failure, nor verify a new backend contract.
- No newly redacted authenticated raw payload set was collected across all
  supported chains/types. Do not promote synthetic fixtures to live evidence.

## Initial audit verification and release gates

The initial audit repairs have RED-to-GREEN regressions. That checkpoint's
selected verification was run after its last source change:

| Verification | Result |
| --- | --- |
| Fomo DOM, bridge, fetch/XHR interception (3 files) | 95 passed |
| Repository, Pump collector, retention, scheduler (4 files) | 65 passed |
| Feed, Side Panel, Float Panel, translation (9 files) | 222 passed |
| Event cards and style contract (2 files) | 44 passed |
| Integrated selected regression set | 18 files, 426 passed, 0 failed; exit 0 |
| `node node_modules/typescript/bin/tsc --noEmit` | exit 0 |
| `node node_modules/wxt/bin/wxt.mjs build` | exit 0; Chrome MV3 output, approximately 1.26 MB |
| `git diff --check` | exit 0 |

The integrated test run used one worker, a 60-second per-test timeout, and a
temporary setup setting Testing Library's asynchronous wait timeout to ten
seconds. Repository defaults and assertions were not relaxed or rewritten for
that run. An earlier expanded run had 21 failures; its timeouts are not counted
as passes. The controlled selected run passed. At that checkpoint, the full
repository suite and Playwright E2E had not been run. The follow-up section below
records the subsequent full unit/integration run; Playwright and live candidate
validation remain release gates.

Local JSON evidence is in `.output/audit-integrated-results.json`. The temporary
runner configuration is `.output/audit-vitest.config.ts`; these diagnostic files
are ignored and are not included in extension output. The synthetic fixture
digest in the activity-contract document was checked against the current file.

The built candidate remains in the isolated worktree. No commit, main merge,
push, release upload, ZIP replacement, or installed-extension reload was
performed. Browser observations above describe the existing browser context,
not end-to-end validation of this newly built candidate.

Before a release, validate the candidate in an isolated extension profile:

1. Fomo live buy/sell/opinion rows, correct token thumbnails, no chart false positives.
2. English and Chinese DOM fallback, with missing and failing images.
3. Pump catch-up exceeding 100 rows, worker restart between acknowledgements,
   acknowledgement timeout, and retry deduplication.
4. Load-more under continuous live messages and sparse-filter continuation.
5. Side Panel/PiP handoff while local translation is in flight.
6. Retention/replay with aliases, and bounded large-response observation.
7. Capture latency, query rows scanned, storage writes, rendered card count,
   and browser long tasks in a controlled profile without unrelated extensions.

For the next performance batch, compare the same seeded history and live-event
rate before and after each change. Record capture-to-persist and
persist-to-visible latency percentiles, examined database rows per page,
storage writes/change broadcasts per batch, card renders per health-only
update, mounted-card count, translation concurrency, and browser long tasks.
Do not use whole-tab memory or synthetic render counts alone as evidence of
user-visible latency improvement.

## Follow-up checkpoint: sparse history and installer minimum

The empty scan-exceeded state now renders user-triggered pagination when
`hasMore` is true. It reuses the existing button, styling, localized labels,
and query cursor. Card layout, filter semantics, query protocol, schema,
retention policy, and scan caps are unchanged. Independent requirement and
code-quality reviews found no outstanding issues in this change.

The installer guide and development prerequisites now specify Chrome 141,
matching `wxt.config.ts`. A guide/configuration consistency test prevents the
two requirements from drifting again.

| Verification | Result |
| --- | --- |
| History feed, event queries, feed hook, installer guide | 4 files, 112 passed, 0 failed; exit 0 |
| Type checking | exit 0 |
| Chrome MV3 build | exit 0; approximately 1.26 MB |
| `git diff --check` | exit 0 |

The root test run used one worker and a 60-second per-test timeout with the
repository's default Testing Library async timeout. Evidence is in
`.output/continuation-checkpoint-results.json`. These selected tests are a new
checkpoint, not a claim that the entire repository suite was run.

The deeper physical scan-budget design remains open: it must expose resumable
examined-row progress rather than silently truncate matched-result arrays.
The candidate is still local to the isolated worktree; no Git commit, merge,
push, ZIP replacement, release upload, or installed-extension reload occurred.

## Follow-up checkpoint: Pump badge and worker-test isolation

`ingestPumpBatch` refreshes the badge once after its ingestion loop, before
writing the Pump checkpoint and acknowledging success. Each event still keeps
the original persistence, sound, broadcast, and enrichment order. Empty,
duplicate-only, invalid, and stale-lease batches retain their previous behavior.

Failure coverage includes a third-item persistence error, a first-item
persistence error, and an error after the first event has already been stored
but before ingestion returns a successful outcome. Partial progress refreshes
the actual stored unread count and never advances the checkpoint. A badge error
on the success path still prevents acknowledgement; on an already-failed path
it is diagnosed separately without replacing the primary ingestion error.

Independent repeated tests exposed a harness isolation defect despite an
earlier passing full run: old simulated workers' bootstrap, detached connection
handlers, and health timers accessed a rebound global browser. The test harness
now binds asynchronous work to its own fake browser/chrome context, explicitly
restores that context for fake-timer callbacks, tracks known asynchronous API
and ingestion/repository work, and cancels owned timers at restart/teardown.
Startup is observed rather than assumed complete after a timer tick. Hydration
is released before cleanup waiting, and synchronous user-activation assertions
remain intact. These changes are test-only; they do not claim a corresponding
production Chrome connection defect or complete tracking of every possible
asynchronous resource.

Code-quality review identified one nonblocking cleanup gap: the returned
detached enrichment promise was not included in tracked ingestion work. It is
now registered before the outer ingestion promise is removed. A deferred real
metric-cache-write regression first reproduced premature cleanup, then verified
that batch acknowledgement remains immediate while teardown waits for that
write to finish. Production enrichment scheduling is unchanged.

Health buffering and broadcast batching remain deferred. Deferred health
writes could lose unflushed diagnostic increments on abrupt worker termination;
broadcast batching would change enrichment ordering and duplicate-replay
recovery. Neither trade-off is silently included in this badge optimization.

| Final follow-up verification | Result |
| --- | --- |
| Targeted worker, ingestion, and badge suites | 3 files, 103 passed after enrichment cleanup regression; preceding 102-test set passed twice |
| Independent requirements review | 3 minimal failure combinations passed; cold activation/restart/fake-timer group 8 passed; related 102 passed |
| Root full unit/integration suite | 101 files, 1,868 passed, 0 failed, 0 skipped; exit 0 |
| Root type checking | exit 0 |
| Root Chrome MV3 build | exit 0; approximately 1.26 MB |
| `git diff --check` | exit 0 |

The final root suite used one worker and a 60-second per-test timeout with the
repository's default Testing Library async timeout, without the earlier
temporary audit setup. Evidence is in `.output/followup-final-results.json`.
Dexie connection-close notices occur during test database deletion; they are
not treated as failures or described as a warning-free run. Browser E2E and
real candidate latency profiling were not performed in this follow-up.

The primary `main` checkout remains unchanged. All repairs and the fresh build
remain in `codex/english-fomo-fallback`; no commit, merge, push, release upload,
ZIP replacement, or installed-extension reload was performed.

## Follow-up checkpoint: preference read ownership

This batch addresses priority 8 without changing persistence formats, mutation
serialization, capture, polling, filter semantics, or card layout. Each read
takes ownership when it starts, rather than when it completes. Only the most
recent request in the current effect may commit its result. Locale selection
also invalidates reads already in flight, preserving the immediate language
switch without an extra storage read. Failed panel reads retain the last usable
joint settings/annotation snapshot until another relevant storage change.

Before the correction, deferred-read tests reproduced three locale rollbacks,
two theme rollbacks, two panel snapshot rollbacks, and two unhandled panel read
rejections. Thirteen added tests cover these cases and lifecycle/failure edges.
Independent read-only review found no blocking issue; its optional coverage
suggestion was implemented and re-reviewed: a real card's committed note must
survive a failed latest annotation read and a subsequently completed older
snapshot. No review items remain open.

| Final preference-read verification | Result |
| --- | --- |
| Targeted locale, surface-theme, and panel suites | 3 files, 67 passed; exit 0 |
| Full unit/integration suite after the final test addition | 102 files, 1,881 passed, 0 failed, 0 skipped; exit 0 |
| Type checking | exit 0 |
| Chrome MV3 build | exit 0; approximately 1.26 MB |
| `git diff --check` | exit 0 |

Evidence: `.output/preference-ownership-targeted-results.json` and
`.output/preference-ownership-results.json`. Tests used one worker, a 60-second
per-test timeout, and the unchanged Testing Library async timeout. The reviewer
inspected code/tests only; the root performed automated validation. This is
asynchronous-order correctness coverage, not a measured latency improvement.
No installed-candidate browser test, Git write, ZIP replacement, or publication
was performed. The primary `main` checkout remains clean at `c29f48b`.

General read-versus-mutation-acknowledgement ordering remains outside this
minimal batch. The other pending performance priorities also remain separate:
resumable physical scan budgets, diagnostics/card render isolation, bounded
translation concurrency, and a measured retention-backlog policy.

## Follow-up checkpoint: feed render isolation

This batch addresses the diagnostics portion of priority 3. HistoryFeed uses
React's default shallow memoization, with stable panel callbacks and a stable
optional token-navigation fallback. The Advanced diagnostics view owns its
one-second clock and unmounts on other settings tabs or when settings close.
Card markup, capture, filters, stored data, and translation scheduling are
unchanged. Changed event data, annotations, source projection, translation
settings/retry, navigation/copy callbacks, and real locale context still update
the actual cards; the independent inputs are covered separately.

A real 50-card reproduction first failed with 50 time-formatter calls per
health-only update and per diagnostics tick. After isolation, both produce
zero card computations within the same 30-second feed clock bucket. This is
deterministic React/jsdom evidence, not measured browser latency or frame time.
No custom event comparator or per-card memoization was added.

Read-only review caught a freshness regression in the initial memoization:
quiet-feed timestamps could freeze indefinitely. A cross-minute real-card
test reproduced the issue before correction. A feed-only clock wrapper now
changes identity when a parent update observes a new 30-second bucket. Existing
successful status polls keep normal relative-time labels moving, without new
timers or event queries. A parent update across buckets may intentionally
recompute cards, including a health update; zero computation is not claimed
unconditionally. Poll response timing, failures, and browser timer throttling
do not guarantee wall-clock cadence. Advanced diagnostics remain second-level,
but no longer make every feed label update every second. Persistence and
read-marking still use the original clock.

Final read-only review found no remaining blocking or minor findings. The root
performs automated verification; the reviewer did not run tests or builds.
The primary main checkout and installed extension remain unchanged. No Git
write, ZIP replacement, release upload, or installed-browser validation is
included in this batch. Physical scan budgets, bounded translation concurrency,
retention-backlog policy, and real-browser profiling remain pending.

| Final feed-render verification | Result |
| --- | --- |
| Targeted panel/feed/card/diagnostics suites | 5 files, 157 passed; exit 0 |
| Full unit/integration suite after freshness correction | 103 files, 1,894 passed, 0 failed, 0 skipped; exit 0 |
| Type checking | exit 0 |
| Chrome MV3 build | exit 0; approximately 1.26 MB |
| `git diff --check` | exit 0 |

Evidence: `.output/render-isolation-targeted-results.json` and
`.output/render-isolation-results.json`. The final runs use one worker,
a 60-second per-test timeout, and the unchanged Testing Library async timeout.
The previous 156-test scoped report predates the freshness correction and is
not used for this checkpoint.

## Follow-up checkpoint: resumable physical scan budget

The panel now opts into a bounded history query. Legacy array queries and
recovery reconciliation retain their previous behavior. A native reverse
IndexedDB cursor reads existing indexes without a schema migration. Requests
stop at 500 candidate rows or the match limit, whichever comes first, and
return events plus the last examined `(occurredAt, id)` cursor. A physical
budget stop uses the existing scan-exceeded continuation action rather than
automatically scanning the rest of history. Popup-side source/action/search,
chain visibility, and amount filters keep their existing ten-page cap.

Actual openCursor success callbacks were counted in fake-indexeddb: the first
query in 20,000 read rows followed by an older unread row delivers 500 rows,
not all 20,001. Subsequent requests remain resumable and reach the unread row.
Equal-timestamp continuation uses continuePrimaryKey and adds at most two
positioning responses, including when the previous cursor row has expired.
Candidate counts do not include those positioning responses; the physical
callback bound is therefore 502, not an unconditional 500. This bounds records
delivered by the cursor, not database engine traversal, memory bytes, or actual
Chrome latency.

Empty and short explicit pages are not exhaustion when hasMore is true. The
last examined cursor survives dropped malformed event rows, and stalled
continuation metadata fails rather than looping. No lookahead is performed;
an exact limit or budget boundary conservatively reports hasMore and can
require one additional empty request to confirm exhaustion. Composite seeking
preserves ties; timestamp-only cursors still exclude the entire timestamp.

The new query flag is optional and opt-in. Old clients retain the original
repository.page response semantics, and injected array-only clients remain
supported by the new feed loader. There is no claim that an older worker with
a strict pre-extension protocol accepts the new flag: installed extension
contexts must use the same rebuilt version. No stored event format, capture
protocol, chain mapping, persistence acknowledgement, or database version was
changed.

Real worker-boundary coverage preserves legacy unread results while testing
bounded opt-in progress. A real repository/hook integration pauses after an
empty 500-row scan, resumes to an older unread match, and marks only that
revealed eligible event. Native request abort and cursor callback failure
tests reject without hanging and permit later writes. Read-only review has
no remaining critical, important, or minor findings. The reviewer did not
execute tests or builds.

The initial integration fixture recreated filters on every React render,
causing a test-worker heap failure. It was corrected to use the stable filter
identity of the actual panel; no production hook workaround or increased heap
limit was added. Only fresh runs after that fixture correction count as
verification. Browser E2E and candidate latency profiling remain separate.

All changes remain local to the existing isolated worktree. Main, ZIPs,
installed extension, GitHub, and releases are unchanged. Translation concurrency
and retention-backlog policy remain pending.

| Final physical-scan verification | Result |
| --- | --- |
| Repository scan and native failure tests | 38 passed; exit 0 |
| Query, client, hook, and worker group before native-failure additions | 5 files, 152 passed; exit 0 |
| Fresh panel/client/query/real sparse hook group after fixture correction | 4 files, 107 passed; exit 0 |
| Full unit/integration suite after all code/test changes | 105 files, 1,915 passed, 0 failed, 0 skipped; exit 0 |
| Type checking | exit 0 |
| Chrome MV3 build | exit 0; approximately 1.27 MB |
| `git diff --check` | exit 0 |

Evidence: `.output/scan-budget-repository-results.json`,
`.output/scan-budget-targeted-results.json`,
`.output/scan-budget-ui-results.json`, and
`.output/scan-budget-results.json`. Suite counts overlap and are not added
together. Runs use one worker, a 60-second per-test timeout, and the unchanged
Testing Library async timeout. The main checkout remains clean at `c29f48b`.

## Follow-up checkpoint: bounded opinion translation

Each coordinator now schedules at most two active translation pipelines by
default, covering detection, availability, session acquisition, and translation.
Pending jobs use FIFO insertion order and coalesce identical text/target pairs.
A synthetic gated run of 20 different opinions previously entered the API 20
times simultaneously; it now starts two, then drains all 20 without dropping
results. This verifies operation concurrency, not native-model load or browser
latency. Existing cache limits, transient-result retry semantics, latest-target
cache ownership, session LRU policy, and direct user-gesture preparation remain
unchanged.

Caller-owned AbortSignals release only their own subscription. The final
subscriber cancelling removes a queued job before any API work, or prevents
an active job from advancing to the next stage. Active native calls are not
forcibly interrupted and retain their slot until settlement. Abandoned results
are not cached; old completion cannot remove a same-key replacement. Hashing
completion checks destruction/cancellation before entering the API. Destroy
settles queued requests and prevents new stage work; independent session cleanup
errors no longer prevent the remaining handles from being released.

The hook cancels its request on text replacement, clear, translation disable,
target-language change, coordinator replacement, and unmount. Shared consumers
and sessions stay alive for other cards. Preference effects compare primitive
values, preventing equivalent newly allocated preference objects from repeatedly
cancelling/restarting the same request. A pre-existing stale-response fixture
was updated to await actual slow API entry before issuing a replacement: the
new implementation can otherwise correctly cancel it before entry. New mock
fixture types were corrected after type checking; no relaxed compiler settings
or increased async timeout was used.

The limit is per coordinator, not global across host/PiP clients. Pending work
is proportional to mounted live consumers and has no fixed overflow cap; there
is no silent drop policy. Hashing is outside the API concurrency budget. Mixed
language-pair session eviction keeps its previous semantics. Viewport priority,
windowing, native-host scheduling, cancellation during hashing, abrupt-client
lease expiry, and actual installed-browser profiling remain separate. No capture
protocol, stored data format, setting, card layout, or database version changed.

Read-only review found no blocking issues. It independently ran 79 tests before
the final three regression cases were added; root verification below includes
all final changes. Main remains clean at `c29f48b`; no commit, merge, push,
installation reload, ZIP replacement, or release was performed.

| Final translation-queue verification | Result |
| --- | --- |
| Translation, native host/client, and real SidePanel integration group | 9 files, 209 passed; exit 0 |
| Full unit/integration suite | 106 files, 1,935 passed, 0 failed, 0 skipped; exit 0 |
| Type checking | exit 0 |
| Chrome MV3 build | exit 0; approximately 1.27 MB |
| `git diff --check` | exit 0 |

Evidence: `.output/translation-queue-targeted-results.json` and
`.output/translation-queue-results.json`. Counts overlap and are not added.
Runs use one worker, a 60-second per-test timeout, and the unchanged Testing
Library async timeout. Initial red tests are reproduction evidence only.

## Follow-up checkpoint: Pump batch side effects

Pump now aggregates diagnostic persistence and payload-less feed invalidation
within each existing validated batch, capped at 100 items. In the isolated
100-trade real worker-boundary test, diagnostic writes fall from 300 to one
and `events.changed` messages from 100 to one. All 100 trades are still saved
individually with the original deduplication and logical health counters.
`broadcasts` continues to count logically invalidated events rather than
physical runtime messages. These are synthetic operation counts, not measured
native browser latency or an unconditional count under interleaved capture.

A batch-local ingestor shares business dependencies and retains only dirty
flags, not an additional event buffer. Diagnostic snapshots update immediately
in memory; an explicit final flush persists them. Default health recording
and Fomo invalidation remain immediate. Interleaved Fomo capture and overlapping
Pump batches do not inherit another batch's dirty flags or wait for it to finish.
Shared diagnostic state may therefore flush more frequently. No global batch
depth or background timer defers Fomo notification.

Finalization attempts health persistence, feed invalidation, and badge refresh
before the existing Pump checkpoint write and ACK. If later row persistence
fails, the durable prefix still triggers its final refresh and badge update;
the checkpoint does not advance. A primary ingestion error remains primary
when cleanup also fails, and secondary failures are reported separately.
Checkpoint-write failure and replay retain the original idempotent behavior.
Detached enrichment and per-event live-buy eligibility are unchanged; no actual
sound playback is claimed by these tests.

Failed health writes retain the latest pending snapshot for a later explicit
record or flush, with no busy retry loop. Diagnostic storage failure remains
observability-only and does not reject otherwise durable trades. This does not
guarantee durable diagnostic counters during unavailable storage or forced
worker termination. Runtime invalidation preserves the existing best-effort
no-receiver behavior; no notification outbox or delivery guarantee was added.
The batch tail is awaited without a flush timer, but abrupt suspension/crash
recovery still relies on the existing producer checkpoint and retry policy.

Coverage includes empty/duplicate/stale/invalid batches, first and later row
failure, health write failure, badge failure, checkpoint failure, absent runtime
receivers, replay, interleaved Fomo capture, overlapping Pump batches, and gated
finalization. Read-only review additionally reproduced a single-flight ownership
race: work arriving just after drain completion could reuse an ending flush
owner and remain pending. Ownership now releases before async settlement and
is acquired before an empty drain can complete. The regression passes, and
re-review found no remaining issues. Only the fresh post-fix full run below
counts as final verification.

No capture contract, stored event format, health schema, setting, UI layout,
database version, or lease/checkpoint ownership policy changed. Timed Fomo
health-write coalescing, installed-browser regression and long-running profiling,
viewport scheduling, and retention-backlog policy remain separate work. Main
remains clean at `c29f48b`; no commit, merge, push, installed-extension reload,
ZIP replacement, or release was performed.

| Final Pump side-effects verification | Result |
| --- | --- |
| Health, batch effects, ingestion, and real worker-boundary group | 4 files, 139 passed; exit 0 |
| Full unit/integration suite after ownership-race fix | 107 files, 1,951 passed, 0 failed, 0 skipped; exit 0 |
| Type checking | exit 0 |
| Chrome MV3 build | exit 0; approximately 1.27 MB |
| `git diff --check` | exit 0 |

Evidence: `.output/pump-side-effects-targeted-results.json` and
`.output/pump-side-effects-results.json`. Counts overlap and are not added.
Runs use one worker, a 60-second per-test timeout, and the unchanged Testing
Library async timeout. The earlier 1,950-test full run predates the ownership
regression and is not the final verification report.

## Follow-up checkpoint: installed Chrome regression

The user authorized replacing the existing unpacked extension with this
candidate, retaining the old installation files and extension identity. They
also authorized temporary chain, source, locale, and surface changes, followed
by restoration. No permissions were added: both manifests retain `storage`,
`sidePanel`, `offscreen`, and the existing Fomo/Pump host permissions.

The installed directory is
`/Users/a77/Desktop/fomo live feed/Fomo-Live-Feed-v0.6.1-chrome`; extension ID
is `peiodpihnmkaokgccpfflpjnpnnmccfk`. All 30 candidate files were compared
with their installed counterparts and matched. The candidate remains version
0.6.1; this is not a new release. Previous files are retained at
`.output/browser-backup-MgpyxV/extension`. Existing unused hashed assets were
not deleted, so Chrome's reported unpacked size is not the candidate bundle
size. The background artifact SHA-256 is
`1d921d710fe7d5b1759afc8fa01ca00e4745bcdc80c860b9c4862650d2d8ec9a`.

Chrome confirmed extension reload. The Fomo token page was refreshed to
replace its old injected context; the other existing Fomo page was not
refreshed. The Pump page was opened with its existing logged-in session.
No credentials, trading actions, or follow-list changes were involved.

| Installed-browser check | Observed result |
| --- | --- |
| Fomo connection and new capture | Connected; a new BSC buy for PACT arrived after reload, followed by additional buys, sells, and opinions |
| Pump connection and new capture | Live trades arrived, including inu buys and an MGM sell; catching-up and delayed states also occurred |
| Existing history and settings | Stored records remained visible after reload and surface changes |
| Single-source filters | Fomo-only displayed Fomo cards/badges; Pump-only displayed Pump cards/badges; All displayed mixed source records |
| English compact layout | Observed cards had separated trader/token text, token image or initial fallback, amount, chain, and market cap; no overlap seen in the sampled viewport |
| Side Panel to floating host to Document PiP | Both source statuses and stored records appeared in each surface; the explicit always-on-top action opened Document PiP |
| Document PiP to Side Panel | Returned successfully, with live records retained; Chrome's Window menu no longer listed either extension window |
| Temporary settings restoration | Chinese, dark theme, Side Panel, All sources, BSC only, all action types enabled, and blank amount/market-cap bounds were verified |

The current source filter resets to All when a surface is reconstructed. This
was reproduced on both handoff directions. Code inspection explains the
behavior: `SidePanelApp` initializes `filters` from `DEFAULT_FILTERS`; only
chain visibility is loaded/persisted through preferences. It is existing
state ownership behavior, not demonstrated to be introduced by this audit.
Preserving source/action/range selection across handoff remains a UX follow-up;
the complete non-chain filter state must be considered, not just the source.

Pump retained an unresolved History gap indication throughout the test,
including periods in Live status. The warning was not cleared. Live arrival
does not establish history completeness, and the specific gap cause was not
proven. The implementation supports closed gap reasons, but the collector's
`possible-gap` result drops the catch-up reason and the background creates a
gap record with its default `unspecified` reason. A follow-up should preserve
the bounded reason and timestamp through the validated status protocol and
expose them without raw trade/account data. This check does not justify
claiming release readiness or changing the gap flag into a success state.

The visible pipeline snapshot reported an open observed socket, recent
persistence, 1,110 accepted events, 71 duplicates, and 1,039 persisted/logically
broadcast events. It also included two bridge-envelope and two raw-schema
rejections. These are retained, mixed-source counters across old and new
contexts, not fresh-run throughput, physical message/write counts, or proof
that every rejection was erroneous. Their payload-level causes were not
investigated in this checkpoint. Fomo opinions with original text and local
translation were visible; English Fomo website capture itself was not tested
by changing only the extension locale.

Pump's current page also displays BNB Chain callouts and trending assets.
That is page-layout evidence only, not proof that its followed-trade endpoint
now supports BNB events or that the existing Solana adapter covers them.

This was the user's normal Chrome profile with multiple trading pages and
other active extensions. No attributable CPU/memory, long-task, or percentile
latency measurements were made. No sound-playback, dual-source identity merge,
long-running suspension, or gap-recovery completeness claim is made. The
candidate is left installed, and Pump remains open; original display/filter
settings are restored. No source code changed during this browser checkpoint,
and no commit, merge, push, ZIP replacement, or release was performed.
