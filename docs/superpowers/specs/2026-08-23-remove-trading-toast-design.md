# Remove Trading-Page Toast Overlay Design

**Date:** 2026-08-23

## Objective

Remove the floating activity cards injected into DexScreener and GMGN pages.
Fomo Live Feed will surface activity only through Chrome's Side Panel, reducing
visual noise and the extension's access to third-party trading pages.

## User-visible behavior

- DexScreener and GMGN pages contain no Fomo Live Feed host element, Shadow
  DOM, toast stack, or floating card.
- New Fomo activity continues to appear in the Side Panel in real time and
  remains available in local history.
- The Side Panel retains its existing refresh, settings, support, translation,
  copy, unread-state, and history behavior.
- Clicking links from the Side Panel may still navigate to supported external
  sites; navigation does not require page injection or host permissions.

## Architecture and data flow

The retained flow is:

```text
Fomo page interceptor -> isolated Fomo bridge -> service worker
  -> IndexedDB persistence -> activity broadcast -> Side Panel refresh
```

The trading-overlay content-script branch is removed entirely. The service
worker broadcasts the validated event needed by Side Panel consumers without a
toast-suppression verdict. This removes the runtime dependency on muted-trader,
muted-chain, minimum-amount, and toast-duration decisions.

## Removal boundary

Remove:

- `entrypoints/trading-overlay.content/` and its WXT content-script output;
- the trading overlay composition, Toast stack, and toast queue modules;
- Toast-only CSS, localization strings, test fixtures, unit tests, integration
  tests, and closed-Shadow-DOM E2E helpers/assertions;
- the `toast` field from the activity-broadcast protocol;
- the service worker's toast-suppression cache and per-event suppression work;
- DexScreener and GMGN host permissions from the extension manifest.

Retain shared formatting, navigation, chain presentation, and image helpers
when they are still used by Side Panel cards. Do not remove a shared module
solely because its current directory is named `overlay`.

## Stored-settings compatibility

Existing persisted notification and filter fields remain accepted by the
current settings schema. They become dormant compatibility data and are not
consulted by the event-ingestion path. This change does not introduce a new
settings schema version or rewrite user storage.

This deliberately separates UI/runtime removal from a future storage cleanup,
avoiding a migration whose only effect would be deleting harmless legacy data.

## Manifest and permissions

The production manifest must not contain content scripts matching
`dexscreener.com` or `gmgn.ai`, and those origins must be removed from
`host_permissions`. Fomo origins and the translation service permission remain
unchanged because they support the retained capture and translation flows.

The extension name and description should describe a Side Panel activity feed,
not a trading-page overlay.

## Failure handling

Removing the overlay must not weaken existing validation or persistence:

- malformed messages remain rejected at existing trust boundaries;
- duplicate events remain deduplicated;
- persistence and enrichment failures retain existing diagnostics;
- Side Panel consumers continue to recover by querying stored history after an
  event-change notification.

No fallback popup or browser notification is introduced.

## Testing

Follow TDD and preserve coverage for the retained flow:

1. Add or update manifest tests to require no trading-page content script or
   DexScreener/GMGN host permission.
2. Update protocol and ingestion tests so activity broadcasts contain the event
   without a `toast` field or suppression behavior.
3. Delete tests whose only subject is the removed Toast UI or queue.
4. Refactor E2E coverage to prove a live event reaches Side Panel history and
   that a representative trading page receives no injected Fomo host element.
5. Run type checking, all unit/integration tests, production build, E2E, local
   packaging, ZIP listing validation, and SHA-256 validation.

## Documentation and distribution

Update README, development documentation, manual testing guidance, and the
offline `START-HERE.html` guide to describe Side Panel-only behavior. Regenerate
the versioned local-distribution ZIP after all gates pass.

## Acceptance criteria

- No floating Fomo Live Feed card appears on DexScreener or GMGN.
- No Toast host is injected into either page.
- The built manifest contains no trading-overlay content script and requests no
  DexScreener/GMGN host access.
- New Fomo activity still appears in the Side Panel and persists in history.
- Existing Side Panel settings and support panels remain mutually exclusive and
  functional.
- The full automated release gate and local-package validation pass.

## Out of scope

- Replacing Toasts with native Chrome notifications.
- Adding a user-facing switch to restore Toasts.
- Migrating or deleting legacy notification/filter settings.
- Redesigning the Side Panel feed.
