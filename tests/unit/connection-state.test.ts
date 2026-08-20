import { describe, expect, it } from 'vitest';

import {
  ConnectionStateMachine,
  DEFAULT_STALE_AFTER_MS,
  LAST_CONNECTION_STORAGE_KEY,
  readLastConnectionAt,
  writeLastConnectionAt,
  type SessionStorageLike,
} from '../../src/background/connection-state';

const createStorageFake = (initial: Record<string, unknown> = {}) => {
  const records: Record<string, unknown> = { ...initial };
  const get = async (keys: string[]): Promise<Record<string, unknown>> => {
    const result: Record<string, unknown> = {};

    for (const key of keys) {
      if (key in records) {
        result[key] = records[key];
      }
    }

    return result;
  };
  const set = async (items: Record<string, unknown>): Promise<void> => {
    Object.assign(records, items);
  };

  return { records, storage: { get, set } as SessionStorageLike };
};

describe('ConnectionStateMachine', () => {
  it('is offline before any bridge has reported', () => {
    const machine = new ConnectionStateMachine();

    expect(machine.phase(1_000)).toBe('offline');
    expect(machine.phase(1_000 + DEFAULT_STALE_AFTER_MS)).toBe('offline');
  });

  it('is connected immediately after a bridge reports', () => {
    const machine = new ConnectionStateMachine();

    machine.reportConnected(1_000);

    expect(machine.phase(1_000)).toBe('connected');
  });

  it('crosses the 30-second boundary exactly', () => {
    const machine = new ConnectionStateMachine();

    machine.reportConnected(1_000);

    expect(machine.phase(1_000 + DEFAULT_STALE_AFTER_MS - 1)).toBe('connected');
    expect(machine.phase(1_000 + DEFAULT_STALE_AFTER_MS)).toBe('stale');
  });

  it('supports a custom stale-after window', () => {
    const machine = new ConnectionStateMachine({ staleAfterMs: 5_000 });

    machine.reportConnected(1_000);

    expect(machine.phase(5_999)).toBe('connected');
    expect(machine.phase(6_000)).toBe('stale');
  });

  it('stays stale (never offline) long after the last report until a disconnect', () => {
    const machine = new ConnectionStateMachine();

    machine.reportConnected(1_000);

    expect(machine.phase(1_000 + DEFAULT_STALE_AFTER_MS * 10)).toBe('stale');
  });

  it('returns offline after a disconnect even within the stale window', () => {
    const machine = new ConnectionStateMachine();

    machine.reportConnected(1_000);
    machine.reportDisconnected(5_000);

    expect(machine.phase(6_000)).toBe('offline');
    expect(machine.phase(1_000 + DEFAULT_STALE_AFTER_MS)).toBe('offline');
  });

  it('reconnects after a disconnect', () => {
    const machine = new ConnectionStateMachine();

    machine.reportConnected(1_000);
    machine.reportDisconnected(5_000);
    machine.reportConnected(5_500);

    expect(machine.phase(5_800)).toBe('connected');
  });

  it('ignores a stale report timestamp so the machine cannot jump backwards', () => {
    const machine = new ConnectionStateMachine();

    machine.reportConnected(10_000);
    machine.reportConnected(9_000);

    expect(machine.phase(10_000 + DEFAULT_STALE_AFTER_MS - 1)).toBe('connected');
  });

  it('seeds from a persisted initial report timestamp', () => {
    const fresh = new ConnectionStateMachine({ initialReportedAt: 1_000 });

    expect(fresh.phase(1_000 + DEFAULT_STALE_AFTER_MS - 1)).toBe('connected');

    const stale = new ConnectionStateMachine({ initialReportedAt: 1_000 });

    expect(stale.phase(1_000 + DEFAULT_STALE_AFTER_MS)).toBe('stale');
  });

  it('uses the injected clock for the default phase argument', () => {
    let now = 1_000;
    const machine = new ConnectionStateMachine({ now: () => now });

    machine.reportConnected(1_000);

    expect(machine.phase()).toBe('connected');

    now = 1_000 + DEFAULT_STALE_AFTER_MS;

    expect(machine.phase()).toBe('stale');
  });

  it('rejects invalid staleAfterMs', () => {
    expect(() => new ConnectionStateMachine({ staleAfterMs: 0 })).toThrowError(TypeError);
    expect(() => new ConnectionStateMachine({ staleAfterMs: -1 })).toThrowError(TypeError);
    expect(() => new ConnectionStateMachine({ staleAfterMs: 1.5 })).toThrowError(TypeError);
  });

  it.each([
    [-1],
    [1.5],
    [Number.NaN],
    [Number.POSITIVE_INFINITY],
  ])('rejects an invalid report timestamp %p', (at) => {
    const machine = new ConnectionStateMachine();

    expect(() => machine.reportConnected(at)).toThrowError(TypeError);
    expect(() => machine.reportDisconnected(at)).toThrowError(TypeError);
    expect(() => machine.phase(at)).toThrowError(TypeError);
    expect(() => new ConnectionStateMachine({ initialReportedAt: at })).toThrowError(
      TypeError,
    );
  });

  it('exposes every documented phase through the machine', () => {
    const offline = new ConnectionStateMachine();

    expect(offline.phase(1_000)).toBe('offline');

    const connected = new ConnectionStateMachine({ initialReportedAt: 1_000 });

    expect(connected.phase(1_000)).toBe('connected');

    const stale = new ConnectionStateMachine({ initialReportedAt: 1_000 });

    expect(stale.phase(1_000 + DEFAULT_STALE_AFTER_MS)).toBe('stale');
  });
});

describe('session connection timestamp helpers', () => {
  it('reads back a persisted connection timestamp', async () => {
    const { storage } = createStorageFake({ [LAST_CONNECTION_STORAGE_KEY]: 1_800_000_000_000 });

    await expect(readLastConnectionAt(storage)).resolves.toBe(1_800_000_000_000);
  });

  it.each([['not-a-number'], [-1], [1.5], [Number.NaN], [null], [undefined]])(
    'treats an invalid persisted value %p as absent',
    async (value) => {
      const { storage } = createStorageFake({ [LAST_CONNECTION_STORAGE_KEY]: value });

      await expect(readLastConnectionAt(storage)).resolves.toBeUndefined();
    },
  );

  it('returns undefined when nothing was persisted', async () => {
    const { storage } = createStorageFake();

    await expect(readLastConnectionAt(storage)).resolves.toBeUndefined();
  });

  it('writes the timestamp under the session storage key', async () => {
    const { records, storage } = createStorageFake();

    await writeLastConnectionAt(storage, 1_800_000_000_000);

    expect(records[LAST_CONNECTION_STORAGE_KEY]).toBe(1_800_000_000_000);
  });

  it('rejects an invalid write timestamp', async () => {
    const { storage } = createStorageFake();

    await expect(writeLastConnectionAt(storage, -1)).rejects.toThrowError(TypeError);
    await expect(writeLastConnectionAt(storage, 1.5)).rejects.toThrowError(TypeError);
  });
});
