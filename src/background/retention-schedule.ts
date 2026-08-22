import type { SessionStorageLike } from './connection-state';
import type { DiagnosticRecorder } from './diagnostics';
import type { RetentionResult } from './retention';

/**
 * Retention scheduling that survives Manifest V3 worker suspension
 * (BLOCKING 2).
 *
 * The schedule is persisted in chrome.storage.session (the same ephemeral,
 * worker-restart-safe area used for connection state): the last-run timestamp
 * lives on disk, NOT in a nextRetentionAt variable that a fresh worker
 * re-arms to now+6h. On every worker start the bootstrap seeds the scheduler
 * from storage and runs retention immediately if it is due — a fresh worker
 * with no stored timestamp runs promptly, a recent run is skipped, and a run
 * that happened a full interval ago runs again.
 */

/** Key under chrome.storage.session that holds the last retention run time. */
export const LAST_RETENTION_STORAGE_KEY = 'lastRetentionAt';

export const DEFAULT_RETENTION_INTERVAL_MS = 6 * 60 * 60 * 1_000;

const isFiniteNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

/**
 * Pure due-check: no stored timestamp (fresh worker) is ALWAYS due; a stored
 * timestamp is due once a full interval has elapsed.
 */
export function isRetentionDue(
  lastRunAt: number | undefined,
  now: number,
  intervalMs: number,
): boolean {
  if (!Number.isFinite(now) || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    throw new TypeError('now and intervalMs must be finite with a positive interval');
  }

  if (lastRunAt === undefined) {
    return true;
  }

  return now - lastRunAt >= intervalMs;
}

export async function readLastRetentionAt(
  storage: SessionStorageLike,
): Promise<number | undefined> {
  const stored = await storage.get([LAST_RETENTION_STORAGE_KEY]);
  const value = stored[LAST_RETENTION_STORAGE_KEY];

  return isFiniteNonNegativeInteger(value) ? value : undefined;
}

export async function writeLastRetentionAt(
  storage: SessionStorageLike,
  at: number,
): Promise<void> {
  if (!isFiniteNonNegativeInteger(at)) {
    throw new TypeError('at must be a finite non-negative integer');
  }

  await storage.set({ [LAST_RETENTION_STORAGE_KEY]: at });
}

export interface RetentionSchedulerOptions {
  storage: SessionStorageLike;
  /** The bounded cleanup itself; injected so tests need no real IndexedDB. */
  runRetentionFn: (now: number) => Promise<RetentionResult>;
  diagnostics: Pick<DiagnosticRecorder, 'record'>;
  now: () => number;
  intervalMs?: number;
}

/**
 * Persisted, worker-restart-safe retention schedule.
 *
 * - seed() loads the last-run timestamp so a fresh worker knows when the last
 *   run happened.
 * - maybeRun() executes runRetentionFn at most once per interval and persists
 *   the timestamp ONLY after a successful run, so a failed run is retried on
 *   the next worker activity instead of being skipped for another interval.
 * - Storage failures around the schedule itself are recorded as
 *   storage_failure diagnostics and never rethrown.
 */
export class RetentionScheduler {
  private lastRunAt: number | undefined;
  private readonly storage: SessionStorageLike;
  private readonly runRetentionFn: (now: number) => Promise<RetentionResult>;
  private readonly diagnostics: Pick<DiagnosticRecorder, 'record'>;
  private readonly now: () => number;
  private readonly intervalMs: number;

  constructor(options: RetentionSchedulerOptions) {
    const intervalMs = options.intervalMs ?? DEFAULT_RETENTION_INTERVAL_MS;

    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new TypeError('intervalMs must be a positive finite number');
    }

    this.storage = options.storage;
    this.runRetentionFn = options.runRetentionFn;
    this.diagnostics = options.diagnostics;
    this.now = options.now;
    this.intervalMs = intervalMs;
  }

  /** Loads the persisted last-run timestamp (call once at worker bootstrap). */
  async seed(): Promise<void> {
    this.lastRunAt = await readLastRetentionAt(this.storage);
  }

  /**
   * Runs retention now if it is due. Never throws: retention failures and
   * schedule-storage failures are recorded as redacted storage_failure
   * diagnostics and the timestamp is only advanced after a successful run.
   */
  async maybeRun(): Promise<void> {
    const now = this.now();

    if (!isRetentionDue(this.lastRunAt, now, this.intervalMs)) {
      return;
    }

    try {
      await this.runRetentionFn(now);
      this.lastRunAt = now;
      await writeLastRetentionAt(this.storage, now);
    } catch {
      this.diagnostics.record({ code: 'storage_failure', messageType: 'retention' });
    }
  }
}