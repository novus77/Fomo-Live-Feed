/**
 * Authenticated-bridge connection state (design spec sections 4.3 and 8,
 * plan Task 7 Step 4).
 *
 * The state machine is pure and clock-injected: every method accepts an
 * explicit timestamp (defaulting to an injected clock), so unit tests control
 * time exactly and the worker never depends on in-memory state for
 * correctness — the last reported timestamp is persisted to
 * chrome.storage.session and re-seeded after a Manifest V3 suspension.
 *
 * Phases:
 * - connected: a bridge reported within the stale window.
 * - stale: a bridge reported, but longer than the stale window ago.
 * - offline: no report ever (or since a disconnect).
 */

export type ConnectionPhase = 'connected' | 'stale' | 'offline';

export const DEFAULT_STALE_AFTER_MS = 30_000;

/** Key under chrome.storage.session that holds the last bridge report time. */
export const LAST_CONNECTION_STORAGE_KEY = 'lastConnectionAt';

const isFiniteNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

export interface ConnectionStateMachineOptions {
  staleAfterMs?: number;
  /** Re-seed from chrome.storage.session after a worker restart. */
  initialReportedAt?: number;
  now?: () => number;
}

export class ConnectionStateMachine {
  private lastReportedAt: number | undefined;
  private readonly staleAfterMs: number;
  private readonly now: () => number;

  constructor(options: ConnectionStateMachineOptions = {}) {
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;

    if (!Number.isInteger(staleAfterMs) || staleAfterMs <= 0) {
      throw new TypeError('staleAfterMs must be a positive integer');
    }

    this.staleAfterMs = staleAfterMs;
    this.now = options.now ?? (() => Date.now());

    if (options.initialReportedAt !== undefined) {
      this.assertTimestamp(options.initialReportedAt);
      this.lastReportedAt = options.initialReportedAt;
    }
  }

  reportConnected(at: number): void {
    this.assertTimestamp(at);

    // Never let a clock-skewed older report move the machine backwards.
    if (this.lastReportedAt === undefined || at >= this.lastReportedAt) {
      this.lastReportedAt = at;
    }
  }

  reportDisconnected(at: number): void {
    this.assertTimestamp(at);
    this.lastReportedAt = undefined;
  }

  phase(at: number = this.now()): ConnectionPhase {
    this.assertTimestamp(at);

    if (this.lastReportedAt === undefined) {
      return 'offline';
    }

    return at - this.lastReportedAt >= this.staleAfterMs ? 'stale' : 'connected';
  }

  private assertTimestamp(at: number): void {
    if (!isFiniteNonNegativeInteger(at)) {
      throw new TypeError('timestamp must be a finite non-negative integer');
    }
  }
}

/** Minimal chrome.storage.session surface, injectable in unit tests. */
export interface SessionStorageLike {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function readLastConnectionAt(
  storage: SessionStorageLike,
): Promise<number | undefined> {
  const stored = await storage.get([LAST_CONNECTION_STORAGE_KEY]);
  const value = stored[LAST_CONNECTION_STORAGE_KEY];

  return isFiniteNonNegativeInteger(value) ? value : undefined;
}

export async function writeLastConnectionAt(
  storage: SessionStorageLike,
  at: number,
): Promise<void> {
  if (!isFiniteNonNegativeInteger(at)) {
    throw new TypeError('at must be a finite non-negative integer');
  }

  await storage.set({ [LAST_CONNECTION_STORAGE_KEY]: at });
}
