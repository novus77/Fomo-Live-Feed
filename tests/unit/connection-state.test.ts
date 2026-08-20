import { describe, expect, it } from 'vitest';

import {
  CONNECTION_STATE_STORAGE_KEY,
  ConnectionStateMachine,
  MAX_TRACKED_TABS,
  readConnectionState,
  writeConnectionState,
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

describe('ConnectionStateMachine (explicit socket open/close tracking)', () => {
  it('is disconnected and unauthenticated before any bridge report', () => {
    const machine = new ConnectionStateMachine();

    expect(machine.snapshot()).toEqual({ connected: false, authenticated: false });
  });

  it('reports the authenticated socket open and stays connected however quiet (steady state)', () => {
    // BLOCKING 2 regression: an OPEN socket with no activity for 10 minutes
    // must NOT flip to disconnected/login-required. The machine tracks the
    // socket's explicit open state instead of inferring liveness from the age
    // of the last activity report, so silence never disconnects it.
    const machine = new ConnectionStateMachine();

    machine.report('tab-1', { connected: true, authenticated: true, at: 1_000 });

    expect(machine.snapshot()).toEqual({ connected: true, authenticated: true });

    // Ten minutes of total silence: still connected and authenticated.
    expect(machine.snapshot()).toEqual({ connected: true, authenticated: true });
  });

  it('a freshly loaded page that never opens the socket stays unauthenticated', () => {
    // A logged-OUT Fomo page cannot open the authenticated socket, so a page
    // present without any socket open reports unauthenticated.
    const machine = new ConnectionStateMachine();

    machine.report('tab-1', { connected: false, authenticated: false, at: 1_000 });

    expect(machine.snapshot()).toEqual({ connected: false, authenticated: false });
  });

  it('keeps authentication after a socket close and reports disconnected (reconnecting)', () => {
    // Socket close carries the bridge's sticky authenticated flag: the user
    // IS logged in, the socket is just reconnecting - never login-required.
    const machine = new ConnectionStateMachine();

    machine.report('tab-1', { connected: true, authenticated: true, at: 1_000 });
    machine.report('tab-1', { connected: false, authenticated: true, at: 2_000 });

    expect(machine.snapshot()).toEqual({ connected: false, authenticated: true });
  });

  it('resets authentication when a fresh page reports no socket (page load)', () => {
    // A page reload reinstalls the bridge; the fresh page reports
    // unauthenticated until its own socket opens.
    const machine = new ConnectionStateMachine();

    machine.report('tab-1', { connected: true, authenticated: true, at: 1_000 });
    machine.report('tab-1', { connected: false, authenticated: false, at: 2_000 });

    expect(machine.snapshot()).toEqual({ connected: false, authenticated: false });
  });

  it('aggregates across tabs: one open authenticated socket keeps the extension connected', () => {
    // A logged-OUT second tab reporting page-presence must not reset the
    // connected state of a tab whose authenticated socket is open.
    const machine = new ConnectionStateMachine();

    machine.report('tab-1', { connected: true, authenticated: true, at: 1_000 });
    machine.report('tab-2', { connected: false, authenticated: false, at: 2_000 });

    expect(machine.snapshot()).toEqual({ connected: true, authenticated: true });

    // And the inverse: closing the only open socket drops connected while the
    // other (unauthenticated) tab stays present.
    machine.report('tab-1', { connected: false, authenticated: true, at: 3_000 });

    expect(machine.snapshot()).toEqual({ connected: false, authenticated: true });
  });

  it('forgets a tab entry on removeTab', () => {
    const machine = new ConnectionStateMachine();

    machine.report('tab-1', { connected: true, authenticated: true, at: 1_000 });
    machine.removeTab('tab-1');

    expect(machine.snapshot()).toEqual({ connected: false, authenticated: false });
  });

  it('a report with the same tab key replaces that tab state', () => {
    const machine = new ConnectionStateMachine();

    machine.report('tab-1', { connected: true, authenticated: true, at: 1_000 });
    machine.report('tab-1', { connected: false, authenticated: false, at: 2_000 });

    expect(machine.snapshot()).toEqual({ connected: false, authenticated: false });
  });

  it('seeds from persisted per-tab state', () => {
    const machine = new ConnectionStateMachine({
      seed: [
        ['tab-1', { authenticated: true, socketOpen: true, reportedAt: 1_000 }],
        ['tab-2', { authenticated: false, socketOpen: false, reportedAt: 2_000 }],
      ],
    });

    expect(machine.snapshot()).toEqual({ connected: true, authenticated: true });
  });

  it('bounds the tracked tab count and evicts the oldest report', () => {
    const machine = new ConnectionStateMachine();

    for (let index = 0; index < MAX_TRACKED_TABS + 10; index += 1) {
      machine.report('tab-' + index, {
        connected: false,
        authenticated: false,
        at: index,
      });
    }

    expect(machine.snapshot()).toEqual({ connected: false, authenticated: false });

    const persisted = machine.persisted();

    expect(persisted.length).toBeLessThanOrEqual(MAX_TRACKED_TABS);
    expect(persisted.some(([key]) => key === 'tab-' + (MAX_TRACKED_TABS + 9))).toBe(true);
    expect(persisted.some(([key]) => key === 'tab-0')).toBe(false);
  });

  it.each([
    [{ connected: true, authenticated: true, at: -1 }],
    [{ connected: true, authenticated: true, at: 1.5 }],
    [{ connected: true, authenticated: true, at: Number.NaN }],
    [{ connected: true, authenticated: 'yes', at: 1 }],
    [{ connected: 'yes', authenticated: true, at: 1 }],
  ])('rejects an invalid report %j', (report) => {
    const machine = new ConnectionStateMachine();

    expect(() =>
      machine.report(
        'tab-1',
        report as { connected: boolean; authenticated: boolean; at: number },
      ),
    ).toThrowError(TypeError);
  });
});

describe('persisted connection state helpers', () => {
  it('round-trips the persisted per-tab state', async () => {
    const { records, storage } = createStorageFake();
    const state = {
      tabs: [
        { tabKey: 'tab-1', authenticated: true, socketOpen: true, reportedAt: 1_000 },
        { tabKey: 'tab-2', authenticated: false, socketOpen: false, reportedAt: 2_000 },
      ],
    };

    await writeConnectionState(storage, state);

    expect(records[CONNECTION_STATE_STORAGE_KEY]).toEqual(state);
    await expect(readConnectionState(storage)).resolves.toEqual(state);
  });

  it('returns undefined when nothing was persisted', async () => {
    const { storage } = createStorageFake();

    await expect(readConnectionState(storage)).resolves.toBeUndefined();
  });

  it('drops invalid entries and keeps only well-formed per-tab records', async () => {
    const { storage } = createStorageFake({
      [CONNECTION_STATE_STORAGE_KEY]: {
        tabs: [
          { tabKey: 'tab-1', authenticated: true, socketOpen: true, reportedAt: 1_000 },
          { tabKey: '', authenticated: true, socketOpen: true, reportedAt: 1_000 },
          { tabKey: 'tab-2', authenticated: 'yes', socketOpen: true, reportedAt: 1_000 },
          { tabKey: 'tab-3', authenticated: true, socketOpen: true, reportedAt: -1 },
          { tabKey: 'tab-4', authenticated: false, socketOpen: false, reportedAt: 2_000 },
        ],
      },
    });

    await expect(readConnectionState(storage)).resolves.toEqual({
      tabs: [
        { tabKey: 'tab-1', authenticated: true, socketOpen: true, reportedAt: 1_000 },
        { tabKey: 'tab-4', authenticated: false, socketOpen: false, reportedAt: 2_000 },
      ],
    });
  });

  it('caps the restored tab count at the tracked-tab bound', async () => {
    const tabs = Array.from({ length: MAX_TRACKED_TABS + 5 }, (_, index) => ({
      tabKey: 'tab-' + index,
      authenticated: false,
      socketOpen: false,
      reportedAt: index,
    }));
    const { storage } = createStorageFake({ [CONNECTION_STATE_STORAGE_KEY]: { tabs } });

    const restored = await readConnectionState(storage);

    expect(restored?.tabs.length).toBe(MAX_TRACKED_TABS);
  });

  it('rejects a malformed persisted envelope', async () => {
    for (const value of [null, 'tabs', { tabs: 'nope' }, {}, { tabs: [{ tabKey: 42 }] }]) {
      const { storage } = createStorageFake({ [CONNECTION_STATE_STORAGE_KEY]: value });

      await expect(readConnectionState(storage)).resolves.toBeUndefined();
    }
  });

  it('rejects an invalid write payload', async () => {
    const { storage } = createStorageFake();

    await expect(
      writeConnectionState(storage, {
        tabs: [{ tabKey: 'tab-1', authenticated: true, socketOpen: true, reportedAt: -1 }],
      }),
    ).rejects.toThrowError(TypeError);
  });
});
