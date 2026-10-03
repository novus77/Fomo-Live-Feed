# Fomo Capture Recovery

## Approved scope

Repair navigation reconciliation, re-enable DOM recovery when primary capture
stops, and reconcile on page resume. Keep history, filters, settings, origin
guards, deduplication, and existing UI unchanged. Do not refresh pages, read
credentials, issue authenticated requests, merge, commit, or publish.

## Evidence and limits

The installed Fomo scripts match the candidate build. Live diagnostics showed
an empty connection table despite recently persisted activities, no observed
WebSocket activity candidates, and a page-owned WebSocket constructor with a
same-origin iframe containing a different pristine constructor. These observations
identify compatibility risk, not proof that every page socket bypasses observation.
The long-idle upstream failure was not reproduced. Deterministic recovery tests
must not be described as proof of uninterrupted upstream delivery.

## Decisions

- Keep clearing state on actual navigation start: preserving an obsolete socket
  forever would mask a real reload. Reconcile with the current content bridge on
  Fomo URL changes and navigation completion using the existing capture ping.
- Separate sticky authentication from primary-capture freshness. DOM fallback
  becomes eligible immediately after socket close or after 15 seconds without
  a valid primary activity. Quiet capture enables recovery; it does not imply logout
  or force the connection badge offline. The existing 2-second DOM scan schedules it.
- On persisted page hide, report disconnected but retain the page's authentication
  evidence. On pageshow/focus, request a current socket snapshot and republish
  connection state. Do not infer socket reopening merely from a resume event.
- A newly inserted DOM activity may restore a cleared connection only after
  durable ingestion acknowledgement, raw-schema validation, and a reliable
  timezone-qualified absolute timestamp at or after bridge installation or the
  latest page suspension. Initial/periodic scans and relative-only clocks never
  imply a live connection. Track insertion and delivery lifecycle generations;
  pre-suspension acknowledgements or retries may persist data but never restore
  the new lifecycle's connection.
  DOM delivery does not extend primary freshness or disable fallback.
- Use prototype-listener observation in production without replacing the native
  WebSocket constructor. Retain compatibility with the exported constructor
  observer, sharing
  socket ownership so one socket is captured once. Preserve listener options,
  original return semantics, constructor identity, and page handlers. Never inspect
  outbound messages. Reconcile late-attached sockets only from their readyState.
- Record bounded recovery reason codes and timestamps, never page content or
  credentials. No timers that indefinitely prevent worker suspension.

## Acceptance

Tests cover close-to-fallback, quiet-to-fallback without logout, resumed page
without fabricated connection, navigation ping recovery, non-Fomo removal,
fresh DOM activity versus historical data, observer coexistence, listener options,
late socket attachment, and disposal. Run full unit/integration tests, typecheck,
build, and isolated Chromium capture regression. Live upstream idle testing remains
an explicit follow-up rather than a guarantee.
