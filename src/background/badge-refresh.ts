import { applyBadge, projectBadge, type BrowserActionLike } from './badge';
import {
  DEFAULT_STALE_AFTER_MS,
  readLastConnectionAt,
  type ConnectionPhase,
  type SessionStorageLike,
} from './connection-state';

/**
 * Badge refresh that recomputes the connection phase from the PERSISTED
 * last-report timestamp (SHOULD-FIX 6).
 *
 * The old worker code derived the phase from an in-memory machine and only
 * re-ran the projection when some unrelated event called refreshBadge, so a
 * quiet page left the badge purple forever. Deriving the phase here from
 * chrome.storage.session makes every refresh truthful: whatever triggered
 * it, the badge reflects the spec's 30-second stale rule. Combined with the
 * bounded one-shot schedule (nextBadgeCheckDelay), a quiet-but-alive worker
 * flips to gray right after the stale boundary without any events, and a
 * restarted worker re-derives the correct color at bootstrap.
 */

/**
 * Pure phase projection from the persisted report time. undefined (no report
 * ever) is offline; a report older than the stale window is stale; anything
 * within the window is connected.
 */
export function phaseFromReportedAt(
  lastReportedAt: number | undefined,
  now: number,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): ConnectionPhase {
  if (lastReportedAt === undefined) {
    return 'offline';
  }

  return now - lastReportedAt >= staleAfterMs ? 'stale' : 'connected';
}

export interface BadgeRefreshDependencies {
  action: BrowserActionLike;
  storage: SessionStorageLike;
  unreadCount: () => Promise<number>;
  now?: () => number;
}

/**
 * Reads the unread count and the persisted last-report time in parallel and
 * applies the projected badge, so the color always derives from durable
 * state rather than whatever in-memory machine state happens to remain.
 * Returns the persisted report time so callers can arm the bounded
 * stale-boundary re-check without another storage read.
 */
export async function refreshBadge(
  deps: BadgeRefreshDependencies,
): Promise<number | undefined> {
  const [unreadCount, lastConnectionAt] = await Promise.all([
    deps.unreadCount(),
    readLastConnectionAt(deps.storage),
  ]);

  const now = deps.now === undefined ? Date.now() : deps.now();

  await applyBadge(
    deps.action,
    projectBadge(unreadCount, phaseFromReportedAt(lastConnectionAt, now)),
  );

  return lastConnectionAt;
}

/**
 * Delay until the badge should re-check (flip to gray), or null when no
 * report exists so no timer is worth arming. The check runs a small
 * checkAfterBoundaryMs AFTER the stale boundary so a fresh report gets a
 * single bounded one-shot rather than a permanent interval that would keep
 * the MV3 worker busy. A pending timer cannot keep an MV3 service worker
 * alive anyway; if the worker is suspended first, the next restart's
 * bootstrap re-derives the color from the persisted timestamp.
 */
export function nextBadgeCheckDelay(
  lastReportedAt: number | undefined,
  now: number,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
  checkAfterBoundaryMs: number = 1_000,
): number | null {
  if (lastReportedAt === undefined) {
    return null;
  }

  const boundary = lastReportedAt + staleAfterMs;

  return Math.max(0, boundary - now + checkAfterBoundaryMs);
}