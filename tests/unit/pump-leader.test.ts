import { PumpLeaderCoordinator } from '../../src/background/pump-leader';

describe('PumpLeaderCoordinator', () => {
  it('grants exactly one leader and renews only the matching epoch', () => {
    const coordinator = new PumpLeaderCoordinator({ leaseDurationMs: 5_000 });
    const first = coordinator.register(10, 1_000);
    const second = coordinator.register(20, 1_100);

    expect(first).toEqual({ granted: true, tabId: 10, epoch: 1, expiresAt: 6_000 });
    expect(second).toEqual({ granted: false, tabId: 10, epoch: 1, expiresAt: 6_000 });
    expect(coordinator.renew(10, 1, 2_000)).toEqual({
      granted: true,
      tabId: 10,
      epoch: 1,
      expiresAt: 7_000,
    });
    expect(coordinator.renew(10, 0, 2_100).granted).toBe(false);
    expect(coordinator.renew(20, 1, 2_100).granted).toBe(false);
    expect(coordinator.isCurrent(10, 1, 2_100)).toBe(true);
    expect(coordinator.isCurrent(10, 0, 2_100)).toBe(false);
  });

  it('replaces an expired leader with a new epoch', () => {
    const coordinator = new PumpLeaderCoordinator({ leaseDurationMs: 5_000 });
    coordinator.register(10, 1_000);

    expect(coordinator.register(20, 6_001)).toEqual({
      granted: true,
      tabId: 20,
      epoch: 2,
      expiresAt: 11_001,
    });
  });

  it('elects a waiting tab immediately when the leader closes', () => {
    const coordinator = new PumpLeaderCoordinator({ leaseDurationMs: 5_000 });
    coordinator.register(20, 1_000);
    coordinator.register(10, 1_100);

    expect(coordinator.remove(20, 2_000)).toEqual({
      granted: true,
      tabId: 10,
      epoch: 2,
      expiresAt: 7_000,
    });
  });

  it('restores only currently open tabs and never trusts a persisted open lease', () => {
    const coordinator = new PumpLeaderCoordinator({ leaseDurationMs: 5_000 });
    coordinator.register(10, 1_000);
    coordinator.register(20, 1_100);

    expect(coordinator.restore(new Set([20]), 3_000)).toEqual({
      granted: true,
      tabId: 20,
      epoch: 2,
      expiresAt: 8_000,
    });
  });

  it('bounds tracked eligible tabs', () => {
    const coordinator = new PumpLeaderCoordinator({ leaseDurationMs: 5_000, maximumTabs: 2 });
    coordinator.register(1, 1_000);
    coordinator.register(2, 1_100);
    coordinator.register(3, 1_200);

    expect(coordinator.trackedTabIds()).toEqual([1, 3]);
  });
});
