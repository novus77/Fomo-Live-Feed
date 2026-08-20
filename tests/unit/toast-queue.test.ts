import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TradeEventV1 } from '../../src/domain/activity';
import {
  MAX_VISIBLE_TOASTS,
  closeToast,
  createToastQueue,
  expireToast,
  pushToast,
} from '../../src/overlay/toast-queue';

const NOW = 1_800_000_000_000;

function makeEvent(id: string, overrides: Partial<TradeEventV1> = {}): TradeEventV1 {
  return {
    schemaVersion: 1,
    id,
    source: 'fomo',
    traderId: 'trader-' + id,
    traderHandle: 'trader-' + id,
    chain: 'bsc',
    tokenAddress: '0x020bfc650a365f8bb26819deaabf3e21291018b4',
    tokenSymbol: 'FOMO',
    action: 'buy',
    occurredAt: NOW,
    receivedAt: NOW,
    ...overrides,
  };
}

const ids = (queue: readonly TradeEventV1[]): string[] => queue.map((event) => event.id);

describe('pushToast (pure reducer)', () => {
  it('keeps only the newest three visible cards', () => {
    const queue = [makeEvent('1'), makeEvent('2'), makeEvent('3'), makeEvent('4')].reduce(
      pushToast,
      [],
    );

    expect(ids(queue)).toEqual(['2', '3', '4']);
  });

  it('returns visible events oldest-to-newest with the newest at the bottom', () => {
    const queue = [makeEvent('a'), makeEvent('b'), makeEvent('c')].reduce(pushToast, []);

    expect(ids(queue)).toEqual(['a', 'b', 'c']);
  });

  it('drops the oldest card when a fourth arrives so existing cards move up', () => {
    const queue = [
      makeEvent('1'),
      makeEvent('2'),
      makeEvent('3'),
      makeEvent('4'),
      makeEvent('5'),
    ].reduce(pushToast, []);

    expect(ids(queue)).toEqual(['3', '4', '5']);
  });

  it('never exceeds the exported fixed maximum', () => {
    const queue = Array.from({ length: 10 }, (_, index) => makeEvent(String(index))).reduce(
      pushToast,
      [],
    );

    expect(queue.length).toBeLessThanOrEqual(MAX_VISIBLE_TOASTS);
    expect(queue.length).toBe(MAX_VISIBLE_TOASTS);
  });

  it('does not create a second card for a duplicate id', () => {
    const event = makeEvent('1');
    const queue = [event, event].reduce(pushToast, []);

    expect(queue).toHaveLength(1);
    expect(queue[0]?.id).toBe('1');
  });

  it('treats a reconnect replay of an already-visible event as a no-op', () => {
    const first = makeEvent('1');
    const replay = makeEvent('1', { usdAmount: 999 });
    const queue = [first, replay].reduce(pushToast, []);

    expect(ids(queue)).toEqual(['1']);
    expect(queue).toHaveLength(1);
    // The original card is preserved; the replay neither replaces nor
    // duplicates it (spec section 7.1: reconnect replays create no duplicates).
    expect(queue[0]?.usdAmount).toBeUndefined();
  });

  it('does not mutate the input queue', () => {
    const first = makeEvent('1');
    const input = [first];
    const next = pushToast(input, makeEvent('2'));

    expect(input).toHaveLength(1);
    expect(next).not.toBe(input);
  });
});

describe('closeToast (pure reducer)', () => {
  it('removes only the requested card', () => {
    const queue = [makeEvent('1'), makeEvent('2'), makeEvent('3')];

    expect(ids(closeToast(queue, '2'))).toEqual(['1', '3']);
  });

  it('is a no-op for an unknown id', () => {
    const queue = [makeEvent('1')];

    expect(ids(closeToast(queue, 'missing'))).toEqual(['1']);
  });
});

describe('expireToast (explicit tick action)', () => {
  it('removes the expired card without touching the others', () => {
    const queue = [makeEvent('1'), makeEvent('2'), makeEvent('3')];

    expect(ids(expireToast(queue, '1'))).toEqual(['2', '3']);
  });
});

describe('createToastQueue (timing controller with injected clock)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const clock = (): number => Date.now();

  it('rejects an invalid duration and a missing clock', () => {
    expect(() => createToastQueue({ durationMs: 0, now: clock })).toThrow(TypeError);
    expect(() => createToastQueue({ durationMs: -1, now: clock })).toThrow(TypeError);
    expect(() => createToastQueue({ durationMs: Number.NaN, now: clock })).toThrow(TypeError);
    expect(() => createToastQueue({ durationMs: 8000, now: 0 as unknown as () => number })).toThrow(
      TypeError,
    );
  });

  it('exposes visible cards oldest-to-newest capped at three', () => {
    const queue = createToastQueue({ durationMs: 8000, now: clock });

    queue.push(makeEvent('1'));
    queue.push(makeEvent('2'));
    queue.push(makeEvent('3'));
    queue.push(makeEvent('4'));

    expect(ids(queue.visible())).toEqual(['2', '3', '4']);
  });

  it('ignores a duplicate push without restarting its timer', () => {
    const queue = createToastQueue({ durationMs: 8000, now: clock });

    queue.push(makeEvent('1'));
    queue.push(makeEvent('1'));

    vi.advanceTimersByTime(7_999);
    expect(ids(queue.visible())).toEqual(['1']);

    vi.advanceTimersByTime(1);
    expect(queue.visible()).toEqual([]);
  });

  it('expires a card exactly after the configured duration', () => {
    const queue = createToastQueue({ durationMs: 8000, now: clock });

    queue.push(makeEvent('1'));

    vi.advanceTimersByTime(7_999);
    expect(ids(queue.visible())).toEqual(['1']);

    vi.advanceTimersByTime(1);
    expect(queue.visible()).toEqual([]);
  });

  it('expires cards independently by their own entry time', () => {
    const queue = createToastQueue({ durationMs: 8000, now: clock });

    queue.push(makeEvent('1'));
    vi.advanceTimersByTime(4_000);
    queue.push(makeEvent('2'));

    vi.advanceTimersByTime(4_000);
    expect(ids(queue.visible())).toEqual(['2']);

    vi.advanceTimersByTime(4_000);
    expect(queue.visible()).toEqual([]);
  });

  it('hovering pauses ONLY the hovered card while the other two keep expiring', () => {
    const queue = createToastQueue({ durationMs: 8000, now: clock });

    queue.push(makeEvent('1'));
    queue.push(makeEvent('2'));
    queue.push(makeEvent('3'));
    queue.setHovered('2');

    vi.advanceTimersByTime(8_000);

    expect(ids(queue.visible())).toEqual(['2']);
  });

  it('releases a hovered card once the pointer leaves', () => {
    const queue = createToastQueue({ durationMs: 8000, now: clock });

    queue.push(makeEvent('1'));
    queue.setHovered('1');

    vi.advanceTimersByTime(8_000);
    expect(ids(queue.visible())).toEqual(['1']);

    queue.setHovered(null);

    expect(queue.visible()).toEqual([]);
  });

  it('keeps only one card hovered at a time', () => {
    const queue = createToastQueue({ durationMs: 8000, now: clock });

    queue.push(makeEvent('1'));
    queue.push(makeEvent('2'));
    queue.setHovered('1');
    queue.setHovered('2');

    vi.advanceTimersByTime(8_000);

    expect(ids(queue.visible())).toEqual(['2']);
  });

  it('close removes the card and its timer, and stays a no-op afterwards', () => {
    const queue = createToastQueue({ durationMs: 8000, now: clock });

    queue.push(makeEvent('1'));
    queue.close('1');

    vi.advanceTimersByTime(8_000);
    expect(queue.visible()).toEqual([]);
    expect(() => queue.close('1')).not.toThrow();
  });

  it('re-adds a replayed event as a fresh card after it expired', () => {
    const queue = createToastQueue({ durationMs: 8000, now: clock });

    queue.push(makeEvent('1'));
    vi.advanceTimersByTime(8_000);
    expect(queue.visible()).toEqual([]);

    queue.push(makeEvent('1'));

    vi.advanceTimersByTime(7_999);
    expect(ids(queue.visible())).toEqual(['1']);
  });

  it('treats a replay of an already-visible event as a no-op', () => {
    const queue = createToastQueue({ durationMs: 8000, now: clock });

    queue.push(makeEvent('1'));
    queue.push(makeEvent('1'));

    expect(ids(queue.visible())).toEqual(['1']);
  });

  it('preserves existing cards remaining time when the duration changes', () => {
    const queue = createToastQueue({ durationMs: 8000, now: clock });

    queue.push(makeEvent('1'));
    vi.advanceTimersByTime(4_000);
    queue.setDuration(2_000);

    // The existing card keeps its ORIGINAL expiry (4s remaining), not the new
    // 2s window: a settings change must not restart visible cards.
    vi.advanceTimersByTime(3_999);
    expect(ids(queue.visible())).toEqual(['1']);

    vi.advanceTimersByTime(1);
    expect(queue.visible()).toEqual([]);
  });

  it('applies a changed duration only to cards pushed afterwards', () => {
    const queue = createToastQueue({ durationMs: 8_000, now: clock });

    queue.push(makeEvent('1'));
    vi.advanceTimersByTime(4_000);
    queue.setDuration(2_000);
    queue.push(makeEvent('2'));

    // Card 2 enters at t=4000 and expires 2000ms later.
    vi.advanceTimersByTime(1_999);
    expect(ids(queue.visible())).toEqual(['1', '2']);

    vi.advanceTimersByTime(1);
    expect(ids(queue.visible())).toEqual(['1']);
  });

  it('rejects an invalid duration in setDuration', () => {
    const queue = createToastQueue({ durationMs: 8_000, now: clock });

    expect(() => queue.setDuration(0)).toThrow(TypeError);
    expect(() => queue.setDuration(-1)).toThrow(TypeError);
    expect(() => queue.setDuration(Number.NaN)).toThrow(TypeError);
  });
});
