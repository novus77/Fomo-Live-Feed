import { describe, expect, it, vi } from 'vitest';

import type { ConnectionPhase } from '../../src/background/connection-state';
import {
  DEFAULT_STALE_AFTER_MS,
  LAST_CONNECTION_STORAGE_KEY,
  type SessionStorageLike,
} from '../../src/background/connection-state';
import {
  applyBadge,
  BADGE_COLOR_CONNECTED,
  BADGE_COLOR_DISCONNECTED,
  BADGE_TEXT_CAP,
  projectBadge,
  type BrowserActionLike,
} from '../../src/background/badge';
import {
  nextBadgeCheckDelay,
  phaseFromReportedAt,
  refreshBadge,
} from '../../src/background/badge-refresh';

describe('projectBadge', () => {
  it('clears the badge text when there is nothing unread', () => {
    expect(projectBadge(0, 'connected')).toEqual({
      text: '',
      color: BADGE_COLOR_CONNECTED,
    });
  });

  it('renders small unread counts verbatim', () => {
    expect(projectBadge(1, 'connected').text).toBe('1');
    expect(projectBadge(5, 'connected').text).toBe('5');
    expect(projectBadge(99, 'connected').text).toBe('99');
  });

  it('caps the unread count at the exported 99+ ceiling', () => {
    expect(projectBadge(100, 'connected').text).toBe(BADGE_TEXT_CAP);
    expect(projectBadge(1_000, 'connected').text).toBe(BADGE_TEXT_CAP);
    expect(projectBadge(20_000, 'connected').text).toBe(BADGE_TEXT_CAP);
  });

  it('uses purple while connected and gray for stale or offline bridges', () => {
    expect(projectBadge(3, 'connected').color).toBe(BADGE_COLOR_CONNECTED);
    expect(projectBadge(3, 'stale').color).toBe(BADGE_COLOR_DISCONNECTED);
    expect(projectBadge(3, 'offline').color).toBe(BADGE_COLOR_DISCONNECTED);
  });

  it('rejects an invalid unread count', () => {
    for (const count of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => projectBadge(count, 'connected')).toThrowError(TypeError);
    }
  });

  it('derives badge text from the unread count and color from the phase independently', () => {
    expect(projectBadge(99, 'stale')).toEqual({
      text: '99',
      color: BADGE_COLOR_DISCONNECTED,
    });
    expect(projectBadge(0, 'connected')).toEqual({
      text: '',
      color: BADGE_COLOR_CONNECTED,
    });
    expect(projectBadge(7, 'offline')).toEqual({
      text: '7',
      color: BADGE_COLOR_DISCONNECTED,
    });
  });
});

describe('applyBadge', () => {
  const createActionFake = (): { action: BrowserActionLike; calls: string[] } => {
    const calls: string[] = [];

    return {
      calls,
      action: {
        async setBadgeText(details: { text: string }): Promise<void> {
          calls.push('text:' + details.text);
        },
        async setBadgeBackgroundColor(details: { color: string }): Promise<void> {
          calls.push('color:' + details.color);
        },
      },
    };
  };

  it('writes the projected text and color to the browser action', async () => {
    const { action, calls } = createActionFake();

    await applyBadge(action, { text: '42', color: BADGE_COLOR_CONNECTED });

    expect(calls).toEqual(['text:42', 'color:' + BADGE_COLOR_CONNECTED]);
  });

  it('clears the badge text when the state is empty', async () => {
    const { action, calls } = createActionFake();

    await applyBadge(action, { text: '', color: BADGE_COLOR_DISCONNECTED });

    expect(calls[0]).toBe('text:');
  });

  it('propagates action failures to the caller', async () => {
    const action: BrowserActionLike = {
      async setBadgeText() {
        throw new Error('chrome error');
      },
      async setBadgeBackgroundColor() {
        return undefined;
      },
    };

    await expect(applyBadge(action, { text: '1', color: '#000000' })).rejects.toThrowError(
      'chrome error',
    );
  });

  it('exposes the colors used for connected and disconnected states', () => {
    expect(BADGE_COLOR_CONNECTED).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(BADGE_COLOR_DISCONNECTED).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(BADGE_COLOR_CONNECTED).not.toBe(BADGE_COLOR_DISCONNECTED);
  });
});

describe('phaseFromReportedAt (persisted-timestamp badge phase)', () => {
  const STALE_AFTER_MS = 30_000;

  it('is offline when no bridge has ever reported', () => {
    expect(phaseFromReportedAt(undefined, 1_000, STALE_AFTER_MS)).toBe('offline');
  });

  it('is connected within the stale window and stale after it', () => {
    expect(phaseFromReportedAt(1_000, 1_000 + STALE_AFTER_MS - 1, STALE_AFTER_MS)).toBe(
      'connected',
    );
    expect(phaseFromReportedAt(1_000, 1_000 + STALE_AFTER_MS, STALE_AFTER_MS)).toBe('stale');
  });

  it('defaults to the exported 30-second stale window', () => {
    expect(phaseFromReportedAt(1_000, 1_000 + DEFAULT_STALE_AFTER_MS - 1)).toBe('connected');
    expect(phaseFromReportedAt(1_000, 1_000 + DEFAULT_STALE_AFTER_MS)).toBe('stale');
  });
});

describe('refreshBadge (recomputed from the persisted connection timestamp)', () => {
  const createActionFake = (): { action: BrowserActionLike; calls: string[] } => {
    const calls: string[] = [];

    return {
      calls,
      action: {
        async setBadgeText(details: { text: string }): Promise<void> {
          calls.push('text:' + details.text);
        },
        async setBadgeBackgroundColor(details: { color: string }): Promise<void> {
          calls.push('color:' + details.color);
        },
      },
    };
  };

  const createStorageFake = (initial: Record<string, unknown> = {}) => {
    const records: Record<string, unknown> = { ...initial };

    return {
      records,
      storage: {
        async get(keys: string[]): Promise<Record<string, unknown>> {
          const result: Record<string, unknown> = {};

          for (const key of keys) {
            if (key in records) {
              result[key] = records[key];
            }
          }

          return result;
        },
        async set(items: Record<string, unknown>): Promise<void> {
          Object.assign(records, items);
        },
      } as SessionStorageLike,
    };
  };

  it('applies gray when the persisted report is older than the stale window, even without new events', async () => {
    const { action, calls } = createActionFake();
    const { storage } = createStorageFake({
      [LAST_CONNECTION_STORAGE_KEY]: 1_000,
    });

    await refreshBadge({
      action,
      storage,
      unreadCount: async () => 3,
      now: () => 1_000 + DEFAULT_STALE_AFTER_MS,
    });

    expect(calls).toEqual([
      'text:3',
      'color:' + BADGE_COLOR_DISCONNECTED,
    ]);
  });

  it('applies purple when the persisted report is still fresh', async () => {
    const { action, calls } = createActionFake();
    const { storage } = createStorageFake({
      [LAST_CONNECTION_STORAGE_KEY]: 1_000,
    });

    await refreshBadge({
      action,
      storage,
      unreadCount: async () => 0,
      now: () => 1_000 + DEFAULT_STALE_AFTER_MS - 1,
    });

    expect(calls).toEqual(['text:', 'color:' + BADGE_COLOR_CONNECTED]);
  });

  it('applies gray when no report was ever persisted', async () => {
    const { action, calls } = createActionFake();
    const { storage } = createStorageFake();

    await refreshBadge({
      action,
      storage,
      unreadCount: async () => 1,
      now: () => 1_000,
    });

    expect(calls).toEqual(['text:1', 'color:' + BADGE_COLOR_DISCONNECTED]);
  });
});

describe('nextBadgeCheckDelay (bounded badge re-evaluation schedule)', () => {
  const STALE_AFTER_MS = 30_000;

  it('returns null when no report exists so no timer is armed', () => {
    expect(nextBadgeCheckDelay(undefined, 1_000, STALE_AFTER_MS)).toBeNull();
  });

  it('arms a one-shot shortly after the stale boundary for a fresh report', () => {
    const delay = nextBadgeCheckDelay(1_000, 1_000, STALE_AFTER_MS);

    expect(delay).not.toBeNull();
    expect(delay).toBeGreaterThan(STALE_AFTER_MS);
    expect(delay).toBeLessThanOrEqual(STALE_AFTER_MS + 1_000);
  });

  it('fires immediately once the boundary has already passed', () => {
    expect(nextBadgeCheckDelay(1_000, 1_000 + STALE_AFTER_MS, STALE_AFTER_MS)).toBe(1_000);
    expect(nextBadgeCheckDelay(1_000, 1_000 + STALE_AFTER_MS + 5_000, STALE_AFTER_MS)).toBe(0);
  });
});
