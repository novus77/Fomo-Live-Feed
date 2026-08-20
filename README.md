# Fomo Live Feed

A Chrome extension that surfaces real-time activity from traders followed by the authenticated Fomo user while browsing supported trading platforms.

The MVP is currently in the planning stage. See:

- [Design specification](docs/superpowers/specs/2026-08-20-fomo-live-feed-extension-design.md)
- [Implementation plan](docs/superpowers/plans/2026-08-20-fomo-live-feed-extension.md)

## MVP boundaries

- Informational only; no trading or wallet operations.
- Browser-local persistence through IndexedDB and `chrome.storage.local`.
- Requires an authenticated Fomo tab to remain open for real-time delivery.
- Chrome is the initial supported browser.
