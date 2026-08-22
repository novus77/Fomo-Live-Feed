import type { ConnectionPhase } from './connection-state';

/**
 * Toolbar badge projection (design spec section 7.1, plan Task 7 Step 4).
 *
 * Badge text is the unread count capped at 99+ ('' clears the badge in
 * Chrome). Badge color is purple ONLY while a tracked tab's authenticated
 * socket is currently OPEN (BLOCKING 2: explicit open/closed tracking, never
 * an activity-age heuristic - an open but idle socket stays purple), gray
 * otherwise. The colors mirror the annotation swatches used elsewhere in the
 * extension (violet / slate).
 */

export const BADGE_COLOR_CONNECTED = '#8b5cf6';
export const BADGE_COLOR_DISCONNECTED = '#64748b';
export const BADGE_TEXT_CAP = '99+';
export const MAX_BADGE_COUNT = 99;

export interface BadgeState {
  text: string;
  color: string;
}

export function projectBadge(unreadCount: number, phase: ConnectionPhase): BadgeState {
  if (!Number.isInteger(unreadCount) || unreadCount < 0) {
    throw new TypeError('unreadCount must be a non-negative integer');
  }

  const text =
    unreadCount === 0
      ? ''
      : unreadCount > MAX_BADGE_COUNT
        ? BADGE_TEXT_CAP
        : String(unreadCount);

  const color = phase === 'connected' ? BADGE_COLOR_CONNECTED : BADGE_COLOR_DISCONNECTED;

  return { text, color };
}

/** Minimal browser.action surface, injectable in unit tests. */
export interface BrowserActionLike {
  setBadgeText(details: { text: string }): Promise<void>;
  setBadgeBackgroundColor(details: { color: string }): Promise<void>;
}

export async function applyBadge(
  action: BrowserActionLike,
  state: BadgeState,
): Promise<void> {
  await action.setBadgeText({ text: state.text });
  await action.setBadgeBackgroundColor({ color: state.color });
}
