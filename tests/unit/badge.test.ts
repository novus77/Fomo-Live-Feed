import { describe, expect, it } from 'vitest';

import {
  CONNECTION_STATE_STORAGE_KEY,
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
import { refreshBadge } from '../../src/background/badge-refresh';

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

  it('uses purple only while the socket is open and gray otherwise', () => {
    expect(projectBadge(3, 'connected').color).toBe(BADGE_COLOR_CONNECTED);
    expect(projectBadge(3, 'offline').color).toBe(BADGE_COLOR_DISCONNECTED);
  });

  it('rejects an invalid unread count', () => {
    for (const count of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => projectBadge(count, 'connected')).toThrowError(TypeError);
    }
  });

  it('derives badge text from the unread count and color from the phase independently', () => {
    expect(projectBadge(99, 'offline')).toEqual({
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

describe('refreshBadge (recomputed from the persisted per-tab socket state)', () => {
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

  it('applies purple while a tracked socket is open, however quiet (BLOCKING 2 steady state)', async () => {
    const { action, calls } = createActionFake();
    const { storage } = createStorageFake({
      [CONNECTION_STATE_STORAGE_KEY]: {
        tabs: [
          { tabKey: 'tab-1', authenticated: true, socketOpen: true, reportedAt: 1_000 },
        ],
      },
    });

    // 10 minutes later with zero new activity: still purple.
    await refreshBadge({ action, storage, unreadCount: async () => 0 });

    expect(calls).toEqual(['text:', 'color:' + BADGE_COLOR_CONNECTED]);
  });

  it('applies gray when the tracked socket is closed', async () => {
    const { action, calls } = createActionFake();
    const { storage } = createStorageFake({
      [CONNECTION_STATE_STORAGE_KEY]: {
        tabs: [
          { tabKey: 'tab-1', authenticated: true, socketOpen: false, reportedAt: 2_000 },
        ],
      },
    });

    await refreshBadge({ action, storage, unreadCount: async () => 3 });

    expect(calls).toEqual(['text:3', 'color:' + BADGE_COLOR_DISCONNECTED]);
  });

  it('applies gray when no connection state was ever persisted', async () => {
    const { action, calls } = createActionFake();
    const { storage } = createStorageFake();

    await refreshBadge({ action, storage, unreadCount: async () => 1 });

    expect(calls).toEqual(['text:1', 'color:' + BADGE_COLOR_DISCONNECTED]);
  });

  it('applies gray when every tracked tab is unauthenticated', async () => {
    const { action, calls } = createActionFake();
    const { storage } = createStorageFake({
      [CONNECTION_STATE_STORAGE_KEY]: {
        tabs: [
          { tabKey: 'tab-1', authenticated: false, socketOpen: false, reportedAt: 1_000 },
        ],
      },
    });

    await refreshBadge({ action, storage, unreadCount: async () => 0 });

    expect(calls).toEqual(['text:', 'color:' + BADGE_COLOR_DISCONNECTED]);
  });

  it('applies purple when ANY tracked tab has an open socket', async () => {
    const { action, calls } = createActionFake();
    const { storage } = createStorageFake({
      [CONNECTION_STATE_STORAGE_KEY]: {
        tabs: [
          { tabKey: 'tab-1', authenticated: false, socketOpen: false, reportedAt: 1_000 },
          { tabKey: 'tab-2', authenticated: true, socketOpen: true, reportedAt: 2_000 },
        ],
      },
    });

    await refreshBadge({ action, storage, unreadCount: async () => 0 });

    expect(calls).toEqual(['text:', 'color:' + BADGE_COLOR_CONNECTED]);
  });
});
