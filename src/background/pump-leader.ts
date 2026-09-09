export interface PumpLeaseDecision {
  granted: boolean;
  tabId: number;
  epoch: number;
  expiresAt: number;
}

interface EligibleTab {
  registeredAt: number;
  lastSeenAt: number;
}

export class PumpLeaderCoordinator {
  private readonly tabs = new Map<number, EligibleTab>();
  private leader: PumpLeaseDecision | undefined;
  private epoch = 0;
  private readonly leaseDurationMs: number;
  private readonly maximumTabs: number;

  constructor(options: { leaseDurationMs?: number; maximumTabs?: number } = {}) {
    this.leaseDurationMs = options.leaseDurationMs ?? 5_000;
    this.maximumTabs = options.maximumTabs ?? 32;
  }

  register(tabId: number, at: number): PumpLeaseDecision {
    this.assertInputs(tabId, at);
    const existing = this.tabs.get(tabId);
    this.tabs.set(tabId, {
      registeredAt: existing?.registeredAt ?? at,
      lastSeenAt: at,
    });
    this.evictWaitingTabs();

    if (this.leader === undefined || at > this.leader.expiresAt) {
      return this.grant(tabId, at);
    }

    if (this.leader.tabId === tabId) {
      return this.renew(tabId, this.leader.epoch, at);
    }

    return { ...this.leader, granted: false };
  }

  renew(tabId: number, epoch: number, at: number): PumpLeaseDecision {
    this.assertInputs(tabId, at);
    const current = this.leader;
    if (
      current === undefined ||
      current.tabId !== tabId ||
      current.epoch !== epoch ||
      at > current.expiresAt
    ) {
      if (current !== undefined) return { ...current, granted: false };
      return { granted: false, tabId, epoch: this.epoch, expiresAt: at };
    }

    const tab = this.tabs.get(tabId);
    if (tab !== undefined) tab.lastSeenAt = at;
    this.leader = { granted: true, tabId, epoch, expiresAt: at + this.leaseDurationMs };
    return { ...this.leader };
  }

  remove(tabId: number, at: number): PumpLeaseDecision | undefined {
    this.assertInputs(tabId, at);
    this.tabs.delete(tabId);
    if (this.leader?.tabId !== tabId) return this.leader === undefined
      ? undefined
      : { ...this.leader, granted: false };
    this.leader = undefined;
    return this.elect(at);
  }

  restore(openTabIds: ReadonlySet<number>, at: number): PumpLeaseDecision | undefined {
    if (!Number.isInteger(at) || at < 0) throw new TypeError('at must be non-negative');
    for (const tabId of [...this.tabs.keys()]) {
      if (!openTabIds.has(tabId)) this.tabs.delete(tabId);
    }
    for (const tabId of openTabIds) {
      if (Number.isInteger(tabId) && tabId >= 0 && !this.tabs.has(tabId)) {
        this.tabs.set(tabId, { registeredAt: at, lastSeenAt: at });
      }
    }
    this.leader = undefined;
    return this.elect(at);
  }

  trackedTabIds(): number[] {
    return [...this.tabs.keys()].sort((left, right) => left - right);
  }

  isCurrent(tabId: number, epoch: number, at: number): boolean {
    return this.leader !== undefined &&
      this.leader.tabId === tabId &&
      this.leader.epoch === epoch &&
      at <= this.leader.expiresAt;
  }

  private elect(at: number): PumpLeaseDecision | undefined {
    const candidate = [...this.tabs.entries()].sort(
      ([leftId, left], [rightId, right]) =>
        left.registeredAt - right.registeredAt || leftId - rightId,
    )[0];
    return candidate === undefined ? undefined : this.grant(candidate[0], at);
  }

  private grant(tabId: number, at: number): PumpLeaseDecision {
    this.epoch += 1;
    this.leader = {
      granted: true,
      tabId,
      epoch: this.epoch,
      expiresAt: at + this.leaseDurationMs,
    };
    return { ...this.leader };
  }

  private evictWaitingTabs(): void {
    while (this.tabs.size > this.maximumTabs) {
      const candidate = [...this.tabs.entries()]
        .filter(([tabId]) => tabId !== this.leader?.tabId)
        .sort(([, left], [, right]) => left.lastSeenAt - right.lastSeenAt)[0];
      if (candidate === undefined) return;
      this.tabs.delete(candidate[0]);
    }
  }

  private assertInputs(tabId: number, at: number): void {
    if (!Number.isInteger(tabId) || tabId < 0) throw new TypeError('tabId must be non-negative');
    if (!Number.isInteger(at) || at < 0) throw new TypeError('at must be non-negative');
  }
}
