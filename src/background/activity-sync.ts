import type { TradeEventV1 } from '../domain/activity';
import type { HistoryClient, HistoryFailureReason } from '../fomo/history-client';
import type { ActivityBroadcastMessage } from '../messaging/protocol';
import type { EventPageQuery } from '../storage/event-repository';

/**
 * Single-flight recovery coordinator (recovery plan Task 4, message contract
 * Task 5 Step 5).
 *
 * Reconnects can drop activity frames, so when the pipeline reconnects
 * (connection.changed -> connected + authenticated) or the side panel asks
 * for a refresh (sync.request), this coordinator runs a BOUNDED backfill
 * through the authenticated history adapter:
 *
 * - Single-flight: `sync()` returns the SAME in-flight promise to concurrent
 *   callers, so a reconnect storm or a panel refresh racing a reconnect
 *   issues exactly one history request chain.
 * - Bounded window: only events STRICTLY newer than the newest stored event
 *   are recovered; a cold start never reaches further back than `maxGapMs`.
 *   Pages arrive newest-first, so pagination stops the moment an event is at
 *   or below the bound.
 * - Insert path: every recovered event goes through the injected
 *   `events.insert` (the real EventRepository in production), which treats an
 *   already-stored id as a duplicate and returns false — duplicates are
 *   skipped (no broadcast, no count) and existing history, annotations,
 *   mutes, and unread state are never touched. This module NEVER writes
 *   directly to IndexedDB outside the injected repository.
 * - Newly inserted events are broadcast to the overlays and reported to
 *   pipeline health as `activity.recovered` events.
 * - The observable state is the plan's closed ActivitySyncState union
 *   (idle / syncing / updated / current / offline / login-required /
 *   recovery-unavailable / failed). Every transition fires the injected
 *   `onStateChange` hook so the worker can broadcast `sync.changed`.
 */

export const DEFAULT_MAX_RECOVERY_GAP_MS = 24 * 60 * 60 * 1_000;
export const MAX_RECOVERY_PAGES = 20;
export const DEFAULT_SYNC_PAGE_LIMIT = 50;
export const DEFAULT_SYNC_FETCH_TIMEOUT_MS = 10_000;

export type ActivitySyncReason = 'reconnect' | 'manual' | 'stale-panel-open';

/**
 * Closed observable state of the recovery coordinator (plan Task 5 Step 5).
 *
 * - `idle` — nothing has run yet this worker session (lastSucceededAt is
 *   present only when a prior success preceded the idle state).
 * - `syncing` — a single-flight run is in flight with its trigger reason.
 * - `updated` — the last run completed and inserted `added` new events.
 * - `current` — the last run completed and found nothing new.
 * - `offline` / `login-required` / `recovery-unavailable` — the last run
 *   failed with a network / auth / disabled-adapter outcome.
 * - `failed` — the last run failed with a server or malformed outcome;
 *   `retryable` distinguishes a transient server failure from a permanent
 *   parser failure.
 */
export type ActivitySyncState =
  | { status: 'idle'; lastSucceededAt?: number }
  | { status: 'syncing'; reason: ActivitySyncReason; startedAt: number }
  | { status: 'updated'; added: number; finishedAt: number }
  | { status: 'current'; finishedAt: number }
  | { status: 'offline' | 'login-required' | 'recovery-unavailable' }
  | { status: 'failed'; retryable: boolean; finishedAt: number };

export type SyncRunResult =
  | { status: 'completed'; recovered: number; pages: number }
  | { status: 'failed'; reason: HistoryFailureReason };

export interface ActivitySyncDependencies {
  events: {
    insert(event: TradeEventV1): Promise<boolean>;
    page(query: EventPageQuery): Promise<TradeEventV1[]>;
  };
  history: HistoryClient;
  broadcast(message: ActivityBroadcastMessage): void | Promise<void>;
  health?: {
    record(event: { type: 'activity.recovered'; at: number; count: number }): void;
  };
  now?: () => number;
}

export interface ActivitySyncOptions {
  maxGapMs?: number;
  maxPages?: number;
  pageLimit?: number;
  fetchTimeoutMs?: number;
  /** Fired after every state transition (the worker broadcasts sync.changed). */
  onStateChange?: () => void;
}

/** Maps a history-client failure onto the plan's closed state union. */
const toFailureState = (
  reason: HistoryFailureReason,
  finishedAt: number,
): ActivitySyncState => {
  switch (reason) {
    case 'auth':
      return { status: 'login-required' };
    case 'network':
      return { status: 'offline' };
    case 'unavailable':
      return { status: 'recovery-unavailable' };
    case 'server':
      return { status: 'failed', retryable: true, finishedAt };
    case 'malformed':
      return { status: 'failed', retryable: false, finishedAt };
  }
};

const assertPositiveInteger = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
};

export class ActivitySync {
  private readonly maxGapMs: number;
  private readonly maxPages: number;
  private readonly pageLimit: number;
  private readonly fetchTimeoutMs: number;
  private readonly now: () => number;
  private readonly onStateChange: (() => void) | undefined;

  private inFlight: Promise<SyncRunResult> | null = null;
  private latestEventOccurredAt: number | undefined;
  private currentState: ActivitySyncState = { status: 'idle' };

  constructor(
    private readonly deps: ActivitySyncDependencies,
    options: ActivitySyncOptions = {},
  ) {
    this.maxGapMs = options.maxGapMs ?? DEFAULT_MAX_RECOVERY_GAP_MS;
    this.maxPages = options.maxPages ?? MAX_RECOVERY_PAGES;
    this.pageLimit = options.pageLimit ?? DEFAULT_SYNC_PAGE_LIMIT;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_SYNC_FETCH_TIMEOUT_MS;
    this.now = deps.now ?? (() => Date.now());
    this.onStateChange = options.onStateChange;

    for (const [name, value] of [
      ['maxGapMs', this.maxGapMs],
      ['maxPages', this.maxPages],
      ['pageLimit', this.pageLimit],
      ['fetchTimeoutMs', this.fetchTimeoutMs],
    ] as const) {
      assertPositiveInteger(name, value);
    }
  }

  /**
   * Raises the newest-known-event watermark (called with the occurredAt of
   * every live pipeline event the background ingests, and with the newest
   * stored row via seedFromStored). The next backfill only fetches events
   * strictly newer than this watermark.
   */
  observeOccurredAt(occurredAt: number): void {
    if (!Number.isInteger(occurredAt) || occurredAt < 0) {
      throw new TypeError('occurredAt must be a finite non-negative integer');
    }

    this.latestEventOccurredAt = Math.max(this.latestEventOccurredAt ?? 0, occurredAt);
  }

  /** Seeds the watermark from pipeline health's latestEventOccurredAt. */
  seedLatest(occurredAt: number | undefined): void {
    if (occurredAt !== undefined) {
      this.observeOccurredAt(occurredAt);
    }
  }

  /** Seeds the watermark from the newest stored event. */
  async seedFromStored(): Promise<void> {
    const newest = await this.deps.events.page({ limit: 1 });
    const event = newest[0];

    if (event !== undefined) {
      this.observeOccurredAt(event.occurredAt);
    }
  }

  /**
   * Single-flight bounded backfill. Concurrent calls share the in-flight
   * promise; only the first caller's reason wins. Unexpected
   * storage/broadcast failures propagate to the caller (the background root
   * records a storage_failure diagnostic) after the state is moved off
   * 'syncing'.
   */
  sync(options: { reason: ActivitySyncReason }): Promise<SyncRunResult> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }

    const run = this.run(options.reason).finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;

    return run;
  }

  /** Live observable state for the sync.query reply. */
  status(): ActivitySyncState {
    return { ...this.currentState };
  }

  private setState(next: ActivitySyncState): void {
    this.currentState = next;
    this.onStateChange?.();
  }

  private async run(reason: ActivitySyncReason): Promise<SyncRunResult> {
    const startedAt = this.now();
    this.setState({ status: 'syncing', reason, startedAt });

    // Bounded recovery window: only events STRICTLY newer than the newest
    // stored event are recovered, and a cold start (no watermark yet) never
    // reaches further back than maxGapMs from now.
    const lowerBound = Math.max(
      this.latestEventOccurredAt ?? 0,
      startedAt - this.maxGapMs,
    );

    let recovered = 0;
    let pages = 0;
    // Internal pagination cursor from the history API (unrelated to the
    // sync.request payload, which carries no cursor: a request always starts
    // from the newest page and follows nextCursor page by page).
    let cursor: string | undefined;

    try {
      while (pages < this.maxPages) {
        const result = await this.deps.history.fetchHistory({
          ...(cursor !== undefined ? { cursor } : {}),
          limit: this.pageLimit,
          signal: AbortSignal.timeout(this.fetchTimeoutMs),
        });

        if (!result.ok) {
          this.setState(toFailureState(result.reason, this.now()));
          return { status: 'failed', reason: result.reason };
        }

        pages += 1;

        // Pages arrive newest-first, so the first event at or below the bound
        // proves every later page is older still: stop paginating.
        let boundaryReached = false;

        for (const event of result.events) {
          if (event.occurredAt <= lowerBound) {
            boundaryReached = true;
            break;
          }

          // The injected repository returns false for a duplicate id (already
          // stored row); duplicates are skipped — no broadcast, no count, and
          // the stored row (annotations, mutes, unread state) is untouched.
          const inserted = await this.deps.events.insert(event);

          if (!inserted) {
            continue;
          }

          recovered += 1;
          this.observeOccurredAt(event.occurredAt);

          // Broadcast each newly recovered event to the overlays; recovered
          // events surface as toasts (they were missed while disconnected). A
          // failed delivery must never abort the recovery run.
          try {
            await this.deps.broadcast({
              protocolVersion: 1,
              type: 'activity.broadcast',
              payload: { event, toast: true },
            });
          } catch {
            // Broadcast failure is observability-only for recovery.
          }
        }

        if (boundaryReached || result.nextCursor === undefined) {
          break;
        }

        cursor = result.nextCursor;
      }
    } catch (error) {
      // Unexpected (storage/broadcast) failure: never leave the state stuck
      // on 'syncing', but still surface the error so the background root can
      // record its storage_failure diagnostic.
      this.setState({ status: 'failed', retryable: false, finishedAt: this.now() });
      throw error;
    }

    const finishedAt = this.now();

    this.setState(
      recovered > 0
        ? { status: 'updated', added: recovered, finishedAt }
        : { status: 'current', finishedAt },
    );

    await this.deps.health?.record({
      type: 'activity.recovered',
      at: finishedAt,
      count: recovered,
    });

    return { status: 'completed', recovered, pages };
  }
}
