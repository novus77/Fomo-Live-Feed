import type { SidePanelDependencies } from '../sidepanel/SidePanelApp';
import { LocalPreferences } from '../storage/local-preferences';
import { FeedViewStore } from '../sidepanel/feed-view-store';

export type PanelSurface = NonNullable<SidePanelDependencies['surface']>;

/**
 * Creates one browser I/O boundary for the floating host and derives the PiP
 * surface from it without constructing another runtime, storage adapter, or
 * preferences store.
 */
export function createPanelDependencies(
  surface: PanelSurface,
  shared?: SidePanelDependencies,
): SidePanelDependencies {
  if (shared !== undefined) {
    return {
      ...shared,
      preferences:
        shared.preferences ?? new LocalPreferences(shared.storage.local),
      surface,
    };
  }

  const runtime: SidePanelDependencies['runtime'] = {
    sendMessage: (message: unknown) => browser.runtime.sendMessage(message),
    onMessage: browser.runtime.onMessage,
  };
  const storage: SidePanelDependencies['storage'] = {
    local: browser.storage.local,
    onChanged: browser.storage.onChanged,
  };
  const preferences = new LocalPreferences(storage.local);

  return {
    runtime,
    storage,
    preferences,
    feedViewStore: new FeedViewStore(browser.storage.session),
    now: () => Date.now(),
    openLink: (url: URL) => {
      window.open(url.href, '_blank', 'noopener,noreferrer');
    },
    copyText: (text: string) => navigator.clipboard.writeText(text),
    getCurrentWindowId: async () => (await browser.windows.getCurrent()).id ?? 0,
    surface,
  };
}
