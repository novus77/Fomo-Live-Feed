import type { TradeEventV1 } from '../domain/activity';

/**
 * Pure three-card toast queue (design spec section 7.1, plan Task 8).
 *
 * The reducer functions below have NO browser and NO React dependencies and
 * never read the clock: time only ever enters through explicit parameters
 * (the injected now of createToastQueue or the explicit expireToast action),
 * so every test is deterministic.
 *
 * Visible cards are returned oldest-to-newest with the newest at the bottom;
 * existing cards move up when a newer one arrives. The fixed maximum is
 * exactly MAX_VISIBLE_TOASTS. A duplicate id never creates a second card, so
 * reconnect replays of an already-visible event are no-ops.
 */
export const MAX_VISIBLE_TOASTS = 3;

/**
 * Appends an event to the visible queue. Duplicates are ignored (the queue is
 * returned unchanged, so a replayed id does not even refresh its position),
 * and the oldest card is dropped when the queue would exceed the fixed
 * maximum. Never mutates the input queue.
 */
export function pushToast(
  queue: readonly TradeEventV1[],
  event: TradeEventV1,
): TradeEventV1[] {
  if (queue.some((existing) => existing.id === event.id)) {
    return [...queue];
  }

  const next = [...queue, event];

  if (next.length <= MAX_VISIBLE_TOASTS) {
    return next;
  }

  return next.slice(next.length - MAX_VISIBLE_TOASTS);
}

/**
 * Removes one card by id (manual dismissal). Unknown ids are a no-op.
 * Never mutates the input queue.
 */
export function closeToast(
  queue: readonly TradeEventV1[],
  id: string,
): TradeEventV1[] {
  return queue.filter((existing) => existing.id !== id);
}

/**
 * Explicit expiration action: removes the card whose timer expired. The
 * operation is identical to closeToast, but the name documents the caller's
 * intent (a timed dismissal rather than a user action) and lets tests drive
 * expiry without any clock.
 */
export function expireToast(
  queue: readonly TradeEventV1[],
  id: string,
): TradeEventV1[] {
  return closeToast(queue, id);
}

export interface ToastQueueOptions {
  /** How long a card stays visible before it auto-dismisses. */
  durationMs: number;
  /** Injected clock; the controller never calls Date.now() itself. */
  now: () => number;
}

/**
 * Stateful timing layer over the pure reducers. It tracks each card's entry
 * time and hover state so dismissal can be paused per card. Hovering pauses
 * ONLY the hovered card's timer; the other cards keep expiring (plan Task 8
 * step 4). visible() prunes expired non-hovered cards, so a replayed event
 * whose earlier card already left the queue is re-added as a fresh card.
 */
export interface ToastQueue {
  push(event: TradeEventV1): void;
  close(id: string): void;
  /** Pauses the given card's dismissal; null resumes every card. */
  setHovered(id: string | null): void;
  /**
   * Changes the duration used for FUTURE pushes without touching the timings
   * of cards already on screen, so a settings change never restarts visible
   * cards (SHOULD-FIX 9).
   */
  setDuration(durationMs: number): void;
  /** Visible cards, oldest-to-newest, capped at MAX_VISIBLE_TOASTS. */
  visible(): readonly TradeEventV1[];
}

interface ToastTiming {
  expiresAt: number;
  hovered: boolean;
}

export function createToastQueue(options: ToastQueueOptions): ToastQueue {
  if (!Number.isFinite(options.durationMs) || options.durationMs <= 0) {
    throw new TypeError('durationMs must be a positive finite number');
  }

  if (typeof options.now !== 'function') {
    throw new TypeError('now must be a function');
  }

  let durationMs = options.durationMs;
  let cards: TradeEventV1[] = [];
  const timings = new Map<string, ToastTiming>();

  const readNow = (): number => {
    const value = options.now();

    if (!Number.isFinite(value)) {
      throw new TypeError('now must return a finite number');
    }

    return value;
  };

  const pruneTimings = (visible: readonly TradeEventV1[]): void => {
    const visibleIds = new Set(visible.map((event) => event.id));

    for (const id of [...timings.keys()]) {
      if (!visibleIds.has(id)) {
        timings.delete(id);
      }
    }
  };

  const pruneExpired = (now: number): TradeEventV1[] => {
    const next = cards.filter((event) => {
      const timing = timings.get(event.id);

      if (timing === undefined) {
        return false;
      }

      if (timing.hovered) {
        return true;
      }

      return now < timing.expiresAt;
    });

    if (next.length !== cards.length) {
      cards = next;
      pruneTimings(cards);
    }

    return cards;
  };

  return {
    push(event: TradeEventV1): void {
      if (typeof event.id !== 'string' || event.id.length === 0) {
        throw new TypeError('event.id must be a non-empty string');
      }

      if (cards.some((existing) => existing.id === event.id)) {
        return;
      }

      const enteredAt = readNow();
      const next = pushToast(cards, event);

      cards = next;
      pruneTimings(cards);
      timings.set(event.id, {
        expiresAt: enteredAt + durationMs,
        hovered: false,
      });
    },

    close(id: string): void {
      cards = closeToast(cards, id);
      timings.delete(id);
    },

    setDuration(nextDurationMs: number): void {
      if (!Number.isFinite(nextDurationMs) || nextDurationMs <= 0) {
        throw new TypeError('durationMs must be a positive finite number');
      }

      // Existing timings keep their original expiresAt (remaining time is
      // preserved); only cards pushed afterwards use the new window.
      durationMs = nextDurationMs;
    },

    setHovered(id: string | null): void {
      if (id === null) {
        for (const timing of timings.values()) {
          timing.hovered = false;
        }

        return;
      }

      const timing = timings.get(id);

      if (timing === undefined) {
        return;
      }

      // Only one card can be hovered at a time.
      for (const other of timings.values()) {
        other.hovered = false;
      }

      timing.hovered = true;
    },

    visible(): readonly TradeEventV1[] {
      return pruneExpired(readNow());
    },
  };
}
