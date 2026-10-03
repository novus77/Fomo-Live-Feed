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
    expect(coordinator.isCurrent(20, 1, 2_000)).toBe(false);
    expect(coordinator.renew(20, 1, 2_001).granted).toBe(false);
    expect(coordinator.isCurrent(10, 1, 2_000)).toBe(false);
    expect(coordinator.isCurrent(10, 2, 2_000)).toBe(true);
  });

  it('uses a distinct worker identity when a replacement coordinator reuses the first epoch', () => {
    const oldCoordinator = new PumpLeaderCoordinator();
    const replacement = new PumpLeaderCoordinator();
    const oldLease = oldCoordinator.register(10, 1_000);
    oldCoordinator.remove(10, 2_000);
    const newLease = replacement.register(10, 2_001);

    expect(newLease.epoch).toBe(oldLease.epoch);
    expect(replacement.workerSessionId).not.toBe(oldCoordinator.workerSessionId);
    expect(oldCoordinator.isCurrent(10, oldLease.epoch, 2_001)).toBe(false);
    expect(replacement.isCurrent(10, newLease.epoch, 2_001)).toBe(true);
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
