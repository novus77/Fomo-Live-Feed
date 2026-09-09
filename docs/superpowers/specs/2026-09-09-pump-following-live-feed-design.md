# Pump Following Near-Real-Time Feed Design

## Goal

Extend Fomo Live Feed so a logged-in `pump.fun` tab contributes new trades
from every trader followed by the current Pump account. Pump and Fomo events
share one chronological feed and remain independently filterable.

Pump targets one request per second while the page runs normally. When Chrome
throttles the tab, the network fails, or the computer sleeps, the extension
catches up with cursor pagination after execution resumes. The reliability
contract is no silent loss within a bounded recovery window, not guaranteed
one-second delivery in background tabs.

## Confirmed Pump contract

The authenticated Following alerts endpoint accepts `kinds=trade` and returns
trader identity, token details, numeric chain identifier, transaction hash,
buy/sell direction, USD amount, event market cap, and occurrence time.

The official page's NATS `followingFeed.user.*` subscription currently handles
`position` messages and does not expose complete trades. Trade collection
therefore uses the page's HTTP endpoint rather than treating position messages
as trades.

A controlled 60-second test completed 60 requests at one request per second:
all returned `200`, with no `403`, `429`, network failure, or `Retry-After`.
Median latency was 367 ms, p95 was 477 ms, and maximum latency was 492 ms.
This proves short-term tolerance in the tested environment, not a published
Pump rate-limit contract.

## Product decisions

- Fomo and Pump remain independent; failure of one never blocks the other.
- The initial Pump response establishes a watermark and is not imported.
- Only trades observed after connection are eligible for persistence.
- Normal polling targets one request per second and never overlaps requests.
- Background execution may be delayed; recovery uses cursor pagination.
- Recovered trades are displayed but do not play buy sounds.
- No credentials, cookies, authorization headers, signatures, or raw responses
  are read, persisted, forwarded, or logged.
- No per-trader Activity polling or market-data enrichment is introduced.
- Event market cap is shown only when the event contains it.
- Pump/Fomo duplicates render once with merged sources.

## Architecture

### Page-owned poller

A MAIN-world Pump collector on exact supported Pump HTTPS origins uses the
page's authenticated session to call the Following alerts endpoint. It emits
only bounded, schema-shaped trade fields through a Pump-specific window
envelope.

The poller is a state machine:

1. establish session identity and an initial watermark;
2. schedule requests against a one-second target cadence;
3. keep at most one request in flight;
4. detect execution gaps and enter catch-up;
5. back off on errors and recover progressively;
6. stop when leadership, account identity, or origin validity is lost.

An isolated bridge validates `window.source`, exact origin, namespace, protocol
version, message kind, payload size, and field bounds before forwarding data to
the extension background.

### Multi-tab leader election

When multiple Pump tabs are open, exactly one tab polls. The background grants
a short renewable lease to one eligible authenticated tab. A lease epoch stops
a stale former leader from publishing after replacement.

If the leader closes, reloads, loses authentication, or stops renewing, another
eligible tab takes over. If the Pump account changes, the current session stops,
its session watermark is discarded, and the new account establishes a fresh
watermark. Events from two accounts are never mixed.

### Background convergence

The background validates normalized events, checks session epoch and
connection-time boundaries, merges duplicates, persists canonical rows, and
notifies every active surface. Side panel, floating window, and document
picture-in-picture consume the same repository and never own the collector.
Switching surfaces or filters does not restart polling.

## Polling scheduler

- Target cadence: one request per second measured from request start.
- Maximum concurrent requests: one.
- Request timeout: four seconds.
- Slow requests are followed by the next request only after completion; nothing
  is queued or overlapped.
- Successful normal polls read only the newest page.
- More than three seconds since the previous successful poll triggers catch-up.
- Offline state pauses polling; returning online triggers catch-up.
- Monotonic time controls intervals; wall-clock time is only for persisted
  diagnostics and event comparison.

## Watermark and deduplication

The primary Pump key is `chainId + transactionHash`. The session stores the
latest watermark and a bounded set of 2,048 recent keys in
`chrome.storage.session`. This survives service-worker suspension and surface
switching but clears with the browser session.

Canonical deduplication applies:

1. exact chain and transaction hash;
2. exact source and source event identifier;
3. a conservative short-window fingerprint with exact trader identity, chain,
   token address, action, time bucket, and amount.

If required fingerprint fields are missing or conflict, both rows are retained.
Merging a second source updates the existing row without replaying sound.

## Cursor catch-up

Catch-up starts at the newest page and follows the official cursor until it
finds the previous watermark.

- Process at most five pages per batch, then yield before continuing.
- Preserve cursor and candidates between batches.
- Stop after finding the old watermark.
- Stop at 1,000 examined events or a 24-hour occurrence window, whichever comes
  first.
- Reject cursors that are invalid, oversized, repeated, or non-progressing.
- If the endpoint ends or a boundary is reached without finding the watermark,
  expose a possible data gap.
- Buffer events during catch-up, deduplicate, and then persist them in ascending
  occurrence-time order.

The endpoint's retention depth is undocumented. The UI never claims complete
recovery when the old watermark cannot be found.

## Event classification and sound

Accepted events are classified as:

- `live`: discovered by an on-cadence poll after the watermark;
- `recovered`: discovered during catch-up;
- `initial`: part of the first watermark response.

Only a newly inserted `live` buy may trigger the existing global buy sound.
Initial, recovered, sell, thesis, transfer, duplicate, and merged events are
silent.

## Backoff and recovery

For `429`, honor a valid `Retry-After`. Otherwise use 3, 5, 10, 30, and 60
seconds. Add approximately ±20 percent jitter without scheduling before a
server-provided minimum.

Timeouts, network failures, and `500-599` responses use exponential backoff.
After three consecutive successes, reduce one backoff level at a time until the
one-second target returns.

`401` or `403` marks authentication unavailable and stops polling. Collection
resumes only after the page reports a new authenticated session, which creates
a new epoch and watermark.

A `200` response whose critical contract fails validation marks Pump
protocol-incompatible. Pump writes stop while Fomo remains operational.

## Validation and safety bounds

- Require bounded transaction hash, trader identifier, token address, chain,
  action, and occurrence time.
- Bound transaction hashes and token addresses to 128 characters, trader
  identifiers and display names to 256, symbols to 64, URLs to 2,048, and
  cursors to 4,096.
- Reject negative or non-finite canonical financial values. Reject USD amount,
  market cap, or price above `1e15` as corrupt input.
- Keep market cap optional and never synthesize it.
- Reject timestamps materially in the future.
- Accept old timestamps only inside active catch-up bounds.
- Map only confirmed chain identifiers; unknown values remain `unknown`.
- Bound each observed response to 2 MiB and 100 items before bridging.
- Parse items independently so one malformed item does not discard valid peers.
- Stop immediately when the top-level envelope is invalid. For item-level
  failures, stop when at least three items and at least 20 percent of a
  non-empty batch fail required-field validation.
- Reject cursor loops and non-progressing pagination.
- Never persist raw responses or expose them in diagnostics.

## Connection state and UI

Pump status supports:

- `live`: a successful poll occurred within five seconds;
- `catching-up`: cursor recovery is active;
- `delayed`: no successful response for more than five seconds;
- `rate-limited`: `429` backoff is active;
- `authentication-required`: `401` or `403`;
- `protocol-incompatible`: critical validation failed;
- `possible-gap`: recovery ended without locating the watermark;
- `disconnected`: no eligible Pump tab exists.

The toolbar shows one compact indicator. Details appear in a tooltip or existing
status surface without increasing card height.

The approved compact three-row card remains:

1. avatar, name, inline note, time, and projected source badge;
2. action, token icon and symbol, chain badge, amount, and event market cap;
3. `CA:`, truncated address, and aligned copy action.

All shows every confirmed badge. Fomo and Pump filters project only the selected
source badge without mutating stored sources.

## Privacy and diagnostics

Only the confirmed response body fields required by the event contract are
observed. Request headers, cookies, browser storage, embedded-wallet state,
signatures, and authentication tokens are never inspected or forwarded.

Diagnostics contain only bounded counters, closed error codes, state, and
timestamps:

- successful and failed request counts;
- last successful request time;
- accepted, duplicate, merged, and rejected counts;
- catch-up page and possible-gap counts;
- current backoff level;
- supported schema version.

Diagnostics exclude account identifiers, wallet and token addresses,
transaction hashes, session-bearing URLs, and response bodies.

## Testing

### Unit

- cadence, serialization, timeout, and gap detection;
- watermark setup, recent-key eviction, and session restoration;
- cursor batching, progression, loops, limits, and ordered catch-up;
- authentication, rate-limit, server, network, and recovery transitions;
- deterministic jitter through injected randomness;
- strict schema and normalization;
- sound classification and cross-source deduplication;
- source, chain, market-cap, and buy-amount filters.

### Integration

- MAIN-world response through bridge, background, and repository;
- exact-origin and hostile-payload rejection;
- one leader across multiple Pump tabs;
- lease expiry, takeover, account change, and stale-epoch rejection;
- service-worker suspension with session restoration;
- Fomo continuity while Pump is degraded.

### End-to-end and release

CI uses synthetic redacted fixtures and never requires a real Pump account.
Local release verification includes an authenticated Pump smoke test, full
tests, TypeScript checking, production WXT build, package inspection, and
unpacked-extension verification.

Product copy calls the source near-real-time with automatic recovery and does
not claim an official one-second Pump SLA.

## Out of scope

- extracting or storing Pump authentication material;
- polling individual trader pages;
- importing pre-connection history;
- guaranteeing one-second background delivery;
- unlimited recovery beyond the bounded cursor window;
- external market-cap enrichment or a new quote cache;
- fuzzy trader identity matching;
- changing existing Fomo collection semantics.
