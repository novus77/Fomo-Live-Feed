import 'fake-indexeddb/auto';

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { projectBadge } from '../../src/background/badge';
import type { TradeEventV1 } from '../../src/domain/activity';
import { DEFAULT_SETTINGS } from '../../src/domain/settings';
import { createToastQueue, MAX_VISIBLE_TOASTS } from '../../src/overlay/toast-queue';
import {
  HOST_ID,
  HOST_MARKER_ATTRIBUTE,
  installTradingOverlay,
  overlayShadowRoot,
  type OverlayClipboardLike,
  type OverlayRuntimeLike,
  type OverlayStorageLike,
} from '../../src/overlay/trading-overlay';
import { FomoFeedDatabase } from '../../src/storage/database';
import { EventRepository } from '../../src/storage/event-repository';
import {
  SETTINGS_STORAGE_KEY,
  type LocalPreferencesStorage,
} from '../../src/storage/local-preferences';

const NOW = 1_800_000_000_000;
const OCCURRED_AT = Date.parse('2026-08-20T08:15:30.000Z');
const RECEIVED_AT = 1_800_000_000_001;

/**
 * The exact normalized TradeEventV1 the worker broadcasts after ingesting
 * buyFrame (see src/fomo/normalize.ts), and the exact envelope shape from
 * src/background/ingest-activity.ts — this is what must round-trip into a
 * visible card.
 */
const workerEvent: TradeEventV1 = {
  schemaVersion: 1,
  id: 'fomo:activity-1',
  source: 'fomo',
  sourceEventId: 'activity-1',
  sourceTradeId: 'trade-1',
  traderId: 'trader-1',
  traderHandle: 'alpha',
  traderName: 'Alpha Whale',
  traderAvatarUrl: 'https://example.com/avatar.png',
  chain: 'bsc',
  networkId: 56,
  tokenAddress: '0x020bfc650a365f8bb26819deaabf3e21291018b4',
  tokenSymbol: 'FOMO',
  tokenImageUrl: 'https://example.com/token.png',
  action: 'buy',
  usdAmount: 1250.5,
  marketCap: 4_200_000,
  price: 0.42,
  occurredAt: OCCURRED_AT,
  receivedAt: RECEIVED_AT,
};

/** The EXACT message object the worker broadcasts for a given toast flag. */
const workerBroadcast = (toast: boolean) => ({
  protocolVersion: 1 as const,
  type: 'activity.broadcast' as const,
  payload: { event: workerEvent, toast },
});

const createRuntimeFake = () => {
  let listener: ((message: unknown) => void) | null = null;

  return {
    onMessage: {
      addListener(fn: (message: unknown) => void): void {
        listener = fn;
      },
      removeListener(fn: (message: unknown) => void): void {
        if (listener === fn) {
          listener = null;
        }
      },
    } as OverlayRuntimeLike['onMessage'],
    dispatch(message: unknown): void {
      listener?.(message);
    },
  };
};

const createStorageFake = (initial: Record<string, unknown> = {}) => {
  const records: Record<string, unknown> = { ...initial };
  const listeners: Array<(changes: Record<string, unknown>, areaName: string) => void> = [];

  const local: LocalPreferencesStorage = {
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
      const changes: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(items)) {
        if (records[key] !== value) {
          changes[key] = { newValue: value };
        }
      }

      Object.assign(records, items);

      for (const listener of [...listeners]) {
        listener(changes, 'local');
      }
    },
  };

  return {
    local,
    records,
    onChanged: {
      addListener(fn: (changes: Record<string, unknown>, areaName: string) => void): void {
        listeners.push(fn);
      },
      removeListener(fn: (changes: Record<string, unknown>, areaName: string) => void): void {
        const index = listeners.indexOf(fn);

        if (index !== -1) {
          listeners.splice(index, 1);
        }
      },
    } as OverlayStorageLike['onChanged'],
  };
};

const createClipboardFake = (): { clipboard: OverlayClipboardLike; writes: string[] } => {
  const writes: string[] = [];

  return {
    writes,
    clipboard: {
      async writeText(text: string): Promise<void> {
        writes.push(text);
      },
    },
  };
};

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

const installHarness = () => {
  const doc = document;
  const runtime = createRuntimeFake();
  const storage = createStorageFake({ [SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS });
  const { clipboard, writes } = createClipboardFake();

  const cleanup = installTradingOverlay({
    document: doc,
    now: () => NOW,
    runtime,
    storage,
    clipboard,
    styleText: '',
  });

  cleanups.push(cleanup);

  return { doc, runtime, storage, clipboard: writes, cleanup };
};

const cardCount = (doc: Document): number => {
  const shadow = overlayShadowRoot(doc);

  return shadow === undefined ? 0 : shadow.querySelectorAll('.toast-card').length;
};

describe('trading overlay broadcast handling', () => {
  it('renders a toast card for the exact message the worker broadcasts', async () => {
    const { doc, runtime } = installHarness();

    await act(async () => {
      runtime.dispatch(workerBroadcast(true));
    });

    const shadow = overlayShadowRoot(doc);

    expect(shadow).toBeDefined();
    expect(cardCount(doc)).toBe(1);
    expect(shadow?.querySelector('.toast-trader-name')?.textContent).toBe('Alpha Whale');
    expect(shadow?.querySelector('.toast-action')?.textContent).toBe('Buy');
    expect(shadow?.querySelector('.toast-token-symbol')?.textContent).toBe('$FOMO');
  });

  it('renders NO card when the worker broadcast carries toast:false', async () => {
    const { doc, runtime } = installHarness();

    await act(async () => {
      runtime.dispatch(workerBroadcast(false));
    });

    // The event is still protocol-valid, but the muted/chain/min-amount
    // suppression flag means the overlay shows no toast.
    expect(cardCount(doc)).toBe(0);
  });

  it('accepts only activity.broadcast messages at the overlay boundary', async () => {
    const { doc, runtime } = installHarness();

    await act(async () => {
      runtime.dispatch({
        protocolVersion: 1,
        type: 'connection.changed',
        payload: { connected: true, at: NOW },
      });
      runtime.dispatch({
        protocolVersion: 1,
        type: 'events.query',
        payload: { limit: 50 },
      });
    });

    expect(cardCount(doc)).toBe(0);
  });

  it('drops a broadcast whose event payload fails field-by-field validation', async () => {
    const { doc, runtime } = installHarness();

    await act(async () => {
      runtime.dispatch({
        protocolVersion: 1,
        type: 'activity.broadcast',
        payload: {
          event: { ...workerEvent, tokenSymbol: '   ' },
          toast: true,
        },
      });
      runtime.dispatch({
        protocolVersion: 1,
        type: 'activity.broadcast',
        payload: { event: { evil: 'field' }, toast: true },
      });
    });

    expect(cardCount(doc)).toBe(0);
  });

  it('never removes a host-page element that merely shares the host id', () => {
    const doc = document;
    const pageElement = doc.createElement('div');

    pageElement.id = HOST_ID;
    pageElement.textContent = 'host page content';
    doc.body.appendChild(pageElement);

    const { cleanup } = installHarness();
    const ourHost = doc.querySelector('[' + HOST_MARKER_ATTRIBUTE + ']');

    // The page element survives untouched...
    expect(doc.getElementById(HOST_ID)).toBe(pageElement);
    expect(pageElement.textContent).toBe('host page content');

    // ...and our own marked host is a separate element.
    expect(ourHost).not.toBeNull();
    expect(ourHost).not.toBe(pageElement);

    cleanup();

    // Cleanup removes only our marked host.
    expect(doc.querySelector('[' + HOST_MARKER_ATTRIBUTE + ']')).toBeNull();
    expect(doc.getElementById(HOST_ID)).toBe(pageElement);
  });

  it('removes an orphaned host from a previous overlay install on reinstall', () => {
    const doc = document;
    const orphan = doc.createElement('div');

    orphan.id = HOST_ID;
    orphan.setAttribute(HOST_MARKER_ATTRIBUTE, '');
    doc.body.appendChild(orphan);

    const { cleanup } = installHarness();

    expect(doc.querySelectorAll('[' + HOST_MARKER_ATTRIBUTE + ']')).toHaveLength(1);

    cleanup();
  });
});

describe('overflow and unread badge', () => {
  it('overflow beyond the three visible cards still increments the unread badge', async () => {
    const database = new FomoFeedDatabase('overlay-badge-' + crypto.randomUUID());

    try {
      const repository = new EventRepository(database);
      const queue = createToastQueue({ durationMs: 8_000, now: () => NOW });

      for (let index = 1; index <= 4; index += 1) {
        const event = {
          ...workerEvent,
          id: 'fomo:event-' + index,
          occurredAt: NOW - index,
          receivedAt: NOW,
        };

        await repository.insert(event);
        queue.push(event);
      }

      // Only the newest three are visible...
      expect(queue.visible().map((event) => event.id)).toEqual([
        'fomo:event-2',
        'fomo:event-3',
        'fomo:event-4',
      ]);
      expect(queue.visible().length).toBe(MAX_VISIBLE_TOASTS);

      // ...but all four entered history unread, so the badge shows 4.
      const unread = await repository.unreadCount();

      expect(unread).toBe(4);
      expect(projectBadge(unread, 'connected').text).toBe('4');
    } finally {
      database.close();
      await database.delete();
    }
  });
});
