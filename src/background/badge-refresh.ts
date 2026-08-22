import { applyBadge, projectBadge, type BrowserActionLike } from './badge';
import {
  readConnectionState,
  type SessionStorageLike,
} from './connection-state';

/**
 * Badge refresh that recomputes the connection phase from the PERSISTED
 * per-tab socket state (BLOCKING 2 rewrite).
 *
 * The old worker code inferred the phase from the age of the last bridge
 * report (a 30-second stale window), so an IDLE but OPEN authenticated socket
 * flipped the badge gray 30 seconds after opening - the normal steady state.
 * The badge phase now derives from the EXPLICIT socket open/closed state the
 * bridge tracks (see src/background/connection-state.ts): the badge is purple
 * while any tracked tab's authenticated socket is open, however quiet, and
 * gray the moment every socket is closed or no state was ever reported.
 *
 * The phase is recomputed from chrome.storage.session on every refresh (never
 * from in-memory state), so a restarted worker re-derives the color from
 * durable state at bootstrap. There is deliberately NO stale-boundary timer
 * anymore: a socket close reports connection.changed immediately, which
 * triggers a badge refresh, so the badge never needs to "flip" on a schedule.
 */

export interface BadgeRefreshDependencies {
  action: BrowserActionLike;
  storage: SessionStorageLike;
  unreadCount: () => Promise<number>;
}

/**
 * Reads the unread count and the persisted per-tab socket state in parallel
 * and applies the projected badge.
 */
export async function refreshBadge(
  deps: BadgeRefreshDependencies,
): Promise<void> {
  const [unreadCount, persisted] = await Promise.all([
    deps.unreadCount(),
    readConnectionState(deps.storage),
  ]);

  const connected =
    persisted !== undefined && persisted.tabs.some((tab) => tab.socketOpen);

  await applyBadge(
    deps.action,
    projectBadge(unreadCount, connected ? 'connected' : 'offline'),
  );
}
