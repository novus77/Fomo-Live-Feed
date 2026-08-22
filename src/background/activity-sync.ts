import type { TradeEventV1 } from '../domain/activity';
import type { HistoryClient, HistoryFailureReason } from '../fomo/history-client';
import type { IngestOutcome } from './ingest-activity';
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
 *   callers with the SAME trigger. A call with a different trigger while a
 *   run is in flight schedules a single coalesced follow-up run so it is
 *   never swallowed.
 * - Bounded window: only events strictly after the composite recovery cursor
 *   `(latestEventOccurredAt, latestEventId)` are recovered; a cold start
 *   never reaches further back than `maxGapMs`. Pages arrive newest-first.
 * - Composite cursor: two events sharing a millisecond are both tracked — an
 *   event at the watermark time whose id sorts AFTER the cursor id is
 *   recovered, and only events at-or-before `(occurredAt, id)` are skipped.
 * - Overlap window: the lower bound is the watermark MINUS an overlap
 *   (default 5s), so events that arrived slightly out of order on the live
 *   stream are re-examined and deduplicated by the repository instead of
 *   being skipped forever. The overlap never extends beyond `maxGapMs` from
 *   the run's start.
 * - Out-of-order pages: a page is read in FULL before any boundary verdict.
 *   A page that mixes above-bound and at/below-bound events keeps the
 *   above-bound events and stops pagination after that page; pagination is
 *   never stopped on the strength of a single at/below-bound event alone.
 * - maxPages failure: if pagination reaches `maxPages` with the lower bound
 *   never seen and more pages still available, the run reports
 *   `status: 'failed'` with `retryable: true`, persists a continuation cursor
 *   so the next run resumes from page `maxPages + 1`, and does NOT advance or
 *   persist the watermark cursor (already-inserted rows dedupe by id).
 * - Insert path: every recovered event goes through the injected
 *   `ingestor.ingestRecovered` (the ActivityIngestor in production), which
 *   runs the SAME insert -> broadcast -> enrichment tail as live events —
 *   provisional-network-mapping diagnostics and health records included.
 *   Recovered events use the same event-only broadcast as live events. A
 *   duplicate id returns 'duplicate' — skipped with no
 *   broadcast, no count — and existing history, annotations, mutes, and
 *   unread state are never touched. This module NEVER writes directly to
 *   IndexedDB outside the injected repository.
 * - Persisted cursor: after a SUCCESSFUL run the composite cursor is written
 *   to the injected storage (`recoveryCursor.v1`); on failure it is never
 *   written. Worker bootstrap seeds the watermark from that cursor via
 *   seedFromCursor(), falling back to seedFromStored()/seedLatest().
 * - The observable state is the plan's closed ActivitySyncState union
 *   (idle / syncing / updated / current / offline / login-required /
 *   recovery-unavailable / failed). Every transition fires the injected
 *   `onStateChange` hook so the worker can broadcast `sync.changed`.
 */

export const DEFAULT_MAX_RECOVERY_GAP_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_RECOVERY_OVERLAP_MS = 5_000;
export const MAX_RECOVERY_PAGES = 20;
export const DEFAULT_SYNC_PAGE_LIMIT = 50;
export const DEFAULT_SYNC_FETCH_TIMEOUT_MS = 10_000;
export const RECOVERY_CURSOR_STORAGE_KEY = 'recoveryCursor.v1';
export const RECOVERY_CONTINUATION_CURSOR_STORAGE_KEY = 'recoveryContinuationCursor.v1';

export type ActivitySyncReason = 'reconnect' | 'manual' | 'stale-panel-open';

/**
 * Closed observable state of the recovery coordinator (plan Task 5 Step 5).
 *
 * - `idle` — nothing has run yet this worker session (lastSucceededAt is
 *   present only when a prior success preceded the idle state).
 * - `syncing` — a single-flight run is in flight with its trigger reason;
 *   `pendingFollowUp` is true when a different trigger requested a sync while
 *   the current run was in flight and a follow-up run will execute.
 * - `updated` — the last run completed and inserted `added` new events.
 * - `current` — the last run completed and found nothing new.
 * - `offline` / `login-required` / `recovery-unavailable` — the last run
 *   failed with a network / auth / disabled-adapter outcome.
 * - `failed` — the last run failed with a server, malformed, or
 *   bounded-pagination outcome; `retryable` distinguishes a transient
 *   failure (server, pagination limit) from a permanent parser failure.
 */
export type ActivitySyncState =
  | { status: 'idle'; lastSucceededAt?: number }
  | { status: 'syncing'; reason: ActivitySyncReason; startedAt: number; pendingFollowUp?: boolean }
  | { status: 'updated'; added: number; finishedAt: number }
  | { status: 'current'; finishedAt: number }
  | { status: 'offline' | 'login-required' | 'recovery-unavailable' }
  | { status: 'failed'; retryable: boolean; finishedAt: number };

export type SyncRunResult =
  | { status: 'completed'; recovered: number; pages: number }
  | { status: 'failed'; reason: HistoryFailureReason | 'bounded-pagination' };

/**
 * Persisted composite recovery cursor (issue 5). `latestEventId` names the
 * newest event AT `latestEventOccurredAt` (the tie-breaker for same-millisecond
 * events); it is absent when the watermark was seeded time-only.
 */
export interface RecoveryCursor {
  latestEventOccurredAt: number;
  latestEventId?: string;
  finishedAt: number;
}

/** Minimal chrome.storage.local shape required for the persisted cursor. */
export interface RecoveryCursorStorage {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove?(keys: string[]): Promise<void>;
}

/**
 * Persisted continuation cursor for bounded-pagination recovery. When a run
 * hits `maxPages` with more pages still available, we store the history API
 * `nextCursor` so the next run can resume pagination instead of restarting
 * from the newest page. The stored watermark lets us discard the cursor when
 * the live pipeline has advanced past it.
 */
export interface ContinuationCursor {
  cursor: string;
  latestEventOccurredAt: number;
  latestEventId?: string;
  createdAt: number;
}

/**
 * Validates a stored continuation cursor. Returns undefined for a missing or
 * corrupt record so the caller can start from the newest page.
 */
export function parseContinuationCursor(value: unknown): ContinuationCursor | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const cursor = record.cursor;
  const occurredAt = record.latestEventOccurredAt;
  const eventId = record.latestEventId;
  const createdAt = record.createdAt;

  if (typeof cursor !== 'string' || cursor.length === 0) {
    return undefined;
  }

  if (
    typeof occurredAt !== 'number' ||
    !Number.isInteger(occurredAt) ||
    occurredAt < 0
  ) {
    return undefined;
  }

  if (typeof createdAt !== 'number' || !Number.isInteger(createdAt) || createdAt < 0) {
    return undefined;
  }

  if (
    eventId !== undefined &&
    (typeof eventId !== 'string' || eventId.trim().length === 0)
  ) {
    return undefined;
  }

  return {
    cursor,
    latestEventOccurredAt: occurredAt,
    ...(eventId !== undefined ? { latestEventId: eventId } : {}),
    createdAt,
  };
}

/**
 * Validates a stored recovery cursor. Returns undefined for a missing or
 * corrupt record so the caller can fall back to seedFromStored()/seedLatest().
 */
export function parseRecoveryCursor(value: unknown): RecoveryCursor | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const occurredAt = record.latestEventOccurredAt;
  const eventId = record.latestEventId;
  const finishedAt = record.finishedAt;

  if (
    typeof occurredAt !== 'number' ||
    !Number.isInteger(occurredAt) ||
    occurredAt < 0
  ) {
    return undefined;
  }

  if (typeof finishedAt !== 'number' || !Number.isInteger(finishedAt) || finishedAt < 0) {
    return undefined;
  }

  if (
    eventId !== undefined &&
    (typeof eventId !== 'string' || eventId.trim().length === 0)
  ) {
    return undefined;
  }

  return {
    latestEventOccurredAt: occurredAt,
    ...(eventId !== undefined ? { latestEventId: eventId } : {}),
    finishedAt,
  };
}

export interface ActivitySyncDependencies {
  events: {
    page(query: EventPageQuery): Promise<TradeEventV1[]>;
  };
  /** The ingestor's recovered-event path (same insert -> broadcast -> enrichment tail as live events). */
  ingestor: {
    ingestRecovered(event: TradeEventV1): Promise<IngestOutcome>;
  };
  history: HistoryClient;
  /** Optional persisted-cursor storage (chrome.storage.local in production). */
  storage?: RecoveryCursorStorage;
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
  /** Lower-bound overlap (ms) subtracted from the watermark so out-of-order live arrivals are re-examined. */
  overlapMs?: number;
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

/** True when `a` sorts strictly after `b` by (occurredAt, id). */
const isNewerComposite = (
  a: { occurredAt: number; id: string },
  b: { occurredAt: number; id: string },
): boolean =>
  a.occurredAt > b.occurredAt || (a.occurredAt === b.occurredAt && a.id > b.id);

/** True when cursor `a` sorts strictly after cursor `b` with an optional id tie-breaker. */
const isNewerCursor = (
  a: { occurredAt: number; id?: string },
  b: { occurredAt: number; id?: string },
): boolean => {
  if (a.occurredAt !== b.occurredAt) {
    return a.occurredAt > b.occurredAt;
  }

  // Same millisecond: an id-bearing cursor is newer than a time-only cursor;
  // two time-only cursors are equal; two id-bearing cursors compare by id.
  if (a.id === undefined) {
    return false;
  }

  return b.id === undefined || a.id > b.id;
};

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

const createDeferred = <T>(): Deferred<T> => {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
};

export class ActivitySync {
  private readonly maxGapMs: number;
  private readonly maxPages: number;
  private readonly pageLimit: number;
  private readonly fetchTimeoutMs: number;
  private readonly overlapMs: number;
  private readonly now: () => number;
  private readonly onStateChange: (() => void) | undefined;

  private inFlight: Promise<SyncRunResult> | null = null;
  private inFlightReason: ActivitySyncReason | null = null;
  private pendingFollowUp: ActivitySyncReason | null = null;
  private followUpDeferred: Deferred<SyncRunResult> | null = null;
  private latestEventOccurredAt: number | undefined;
  private latestEventId: string | undefined;
  private currentState: ActivitySyncState = { status: 'idle' };

  constructor(
    private readonly deps: ActivitySyncDependencies,
    options: ActivitySyncOptions = {},
  ) {
    this.maxGapMs = options.maxGapMs ?? DEFAULT_MAX_RECOVERY_GAP_MS;
    this.maxPages = options.maxPages ?? MAX_RECOVERY_PAGES;
    this.pageLimit = options.pageLimit ?? DEFAULT_SYNC_PAGE_LIMIT;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? DEFAULT_SYNC_FETCH_TIMEOUT_MS;
    this.overlapMs = options.overlapMs ?? DEFAULT_RECOVERY_OVERLAP_MS;
    this.now = deps.now ?? (() => Date.now());
    this.onStateChange = options.onStateChange;

    for (const [name, value] of [
      ['maxGapMs', this.maxGapMs],
      ['maxPages', this.maxPages],
      ['pageLimit', this.pageLimit],
      ['fetchTimeoutMs', this.fetchTimeoutMs],
      ['overlapMs', this.overlapMs],
    ] as const) {
      assertPositiveInteger(name, value);
    }
  }

  /**
   * Raises the newest-known-event watermark (called with the occurredAt of
   * every live pipeline event the background ingests, and with the newest
   * stored row via seedFromStored). Time-only: a strictly newer timestamp
   * replaces the composite cursor's id (the id of the newest event at the
   * new timestamp is unknown). Prefer observeEvent() when the id is at hand.
   */
  observeOccurredAt(occurredAt: number): void {
    if (!Number.isInteger(occurredAt) || occurredAt < 0) {
      throw new TypeError('occurredAt must be a finite non-negative integer');
    }

    if (occurredAt > (this.latestEventOccurredAt ?? 0)) {
      this.latestEventOccurredAt = occurredAt;
      this.latestEventId = undefined;
    }
  }

  /**
   * Composite watermark observation: raises the cursor to
   * `(event.occurredAt, event.id)` lexicographically, so two events sharing a
   * millisecond are both tracked (the id breaks the tie). Called with every
   * inserted live event; the recovery run raises it from the newest inserted
   * row at the end of a successful run.
   */
  observeEvent(event: Pick<TradeEventV1, 'occurredAt' | 'id'>): void {
    if (!Number.isInteger(event.occurredAt) || event.occurredAt < 0) {
      throw new TypeError('occurredAt must be a finite non-negative integer');
    }

    if (typeof event.id !== 'string' || event.id.length === 0) {
      throw new TypeError('id must be a non-empty string');
    }

    const currentAt = this.latestEventOccurredAt ?? 0;

    if (event.occurredAt > currentAt) {
      this.latestEventOccurredAt = event.occurredAt;
      this.latestEventId = event.id;
    } else if (
      event.occurredAt === currentAt &&
      (this.latestEventId === undefined || event.id > this.latestEventId)
    ) {
      this.latestEventId = event.id;
    }
  }

  /** Seeds the watermark from pipeline health's latestEventOccurredAt. */
  seedLatest(occurredAt: number | undefined): void {
    if (occurredAt !== undefined) {
      this.observeOccurredAt(occurredAt);
    }
  }

  /** Seeds the watermark from the newest stored event (composite, with id). */
  async seedFromStored(): Promise<void> {
    const newest = await this.deps.events.page({ limit: 1 });
    const event = newest[0];

    if (event !== undefined) {
      this.observeEvent(event);
    }
  }

  /**
   * Seeds the watermark from the persisted recovery cursor. Returns true when
   * a valid cursor was found; false when storage is absent, the key is
   * missing, or the record is corrupt — the caller then falls back to
   * seedFromStored()/seedLatest().
   */
  async seedFromCursor(): Promise<boolean> {
    if (this.deps.storage === undefined) {
      return false;
    }

    const stored = await this.deps.storage.get([RECOVERY_CURSOR_STORAGE_KEY]);
    const cursor = parseRecoveryCursor(stored[RECOVERY_CURSOR_STORAGE_KEY]);

    if (cursor === undefined) {
      return false;
    }

    this.latestEventOccurredAt = cursor.latestEventOccurredAt;
    this.latestEventId = cursor.latestEventId;
    return true;
  }

  /**
   * Single-flight bounded backfill. Concurrent calls with the SAME trigger
   * share the in-flight promise. A call with a different trigger while a run
   * is in flight schedules ONE coalesced follow-up run; multiple overlapping
   * requests collapse into a single follow-up so a manual refresh racing a
   * reconnect recovery is never swallowed.
   */
  sync(options: { reason: ActivitySyncReason }): Promise<SyncRunResult> {
    if (this.inFlight !== null) {
      // Same trigger: exact single-flight semantics.
      if (this.inFlightReason === options.reason) {
        return this.inFlight;
      }

      // Different trigger: mark a coalesced follow-up. Re-fire state change
      // so observers can surface "syncing, with pending refresh".
      this.pendingFollowUp = options.reason;

      if (this.followUpDeferred === null) {
        this.followUpDeferred = createDeferred();
      }

      if (this.currentState.status === 'syncing') {
        this.setState({ ...this.currentState, pendingFollowUp: true });
      }

      return this.followUpDeferred.promise;
    }

    const run = this.run(options.reason).finally(() => {
      this.inFlight = null;
      this.inFlightReason = null;

      const followUpReason = this.pendingFollowUp;
      const followUpDeferred = this.followUpDeferred;
      this.pendingFollowUp = null;
      this.followUpDeferred = null;

      // Schedule the coalesced follow-up. The recursive sync() call handles
      // its own single-flight / follow-up logic; errors propagate to the
      // deferred caller through the returned promise.
      if (followUpReason !== null) {
        this.sync({ reason: followUpReason }).then(
          (result) => followUpDeferred?.resolve(result),
          (error) => followUpDeferred?.reject(error),
        );
      }
    });
    this.inFlight = run;
    this.inFlightReason = options.reason;

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

  /**
   * True when `event` is at-or-before the recovery lower bound, so it must be
   * skipped and a page containing it marks the pagination boundary.
   *
   * The bound is a composite point `(boundMs, cursorId)`. The id component is
   * meaningful ONLY when the bound time coincides with the watermark time (no
   * overlap, or the max-gap floor equals the watermark): then an event on the
   * same millisecond with a lexicographically LATER id is new and is
   * recovered, and only ids at-or-before the cursor id are skipped. Otherwise
   * the bound is a pure time floor — the overlap window is a re-examination
   * region where every event is a candidate (the repository dedupes) — so
   * everything on the bound millisecond is treated as already handled.
   */
  private isAtOrBelowBound(
    event: Pick<TradeEventV1, 'occurredAt' | 'id'>,
    boundMs: number,
  ): boolean {
    if (event.occurredAt < boundMs) {
      return true;
    }

    if (event.occurredAt > boundMs) {
      return false;
    }

    if (
      this.latestEventOccurredAt === undefined ||
      boundMs !== this.latestEventOccurredAt
    ) {
      return true;
    }

    return this.latestEventId === undefined || event.id <= this.latestEventId;
  }

  /**
   * Persists the composite recovery cursor after a SUCCESSFUL run so a
   * restarted worker resumes from exactly here. Failed runs never call this.
   */
  private async persistCursor(finishedAt: number): Promise<void> {
    if (this.deps.storage === undefined) {
      return;
    }

    const cursor: RecoveryCursor = {
      latestEventOccurredAt: this.latestEventOccurredAt ?? 0,
      ...(this.latestEventId !== undefined
        ? { latestEventId: this.latestEventId }
        : {}),
      finishedAt,
    };

    await this.deps.storage.set({ [RECOVERY_CURSOR_STORAGE_KEY]: cursor });
  }

  /**
   * Persists the continuation cursor when a run stops due to bounded
   * pagination, so the next run resumes from page `maxPages + 1` instead of
   * restarting from the newest page.
   */
  private async persistContinuationCursor(nextCursor: string): Promise<void> {
    if (this.deps.storage === undefined) {
      return;
    }

    const cursor: ContinuationCursor = {
      cursor: nextCursor,
      latestEventOccurredAt: this.latestEventOccurredAt ?? 0,
      ...(this.latestEventId !== undefined
        ? { latestEventId: this.latestEventId }
        : {}),
      createdAt: this.now(),
    };

    await this.deps.storage.set({
      [RECOVERY_CONTINUATION_CURSOR_STORAGE_KEY]: cursor,
    });
  }

  /**
   * Clears any persisted continuation cursor. Called after a successful run
   * and when the live watermark has advanced past a stored cursor.
   */
  private async clearContinuationCursor(): Promise<void> {
    if (this.deps.storage === undefined) {
      return;
    }

    if (this.deps.storage.remove !== undefined) {
      await this.deps.storage.remove([RECOVERY_CONTINUATION_CURSOR_STORAGE_KEY]);
    } else {
      await this.deps.storage.set({
        [RECOVERY_CONTINUATION_CURSOR_STORAGE_KEY]: undefined,
      });
    }
  }

  /**
   * Loads a persisted continuation cursor when the watermark has not advanced
   * past it. Returns the history API cursor to resume from, or undefined to
   * start from the newest page.
   */
  private async loadContinuationCursor(): Promise<string | undefined> {
    if (this.deps.storage === undefined) {
      return undefined;
    }

    const stored = await this.deps.storage.get([
      RECOVERY_CONTINUATION_CURSOR_STORAGE_KEY,
    ]);
    const cursor = parseContinuationCursor(
      stored[RECOVERY_CONTINUATION_CURSOR_STORAGE_KEY],
    );

    if (cursor === undefined) {
      return undefined;
    }

    const currentWatermark: { occurredAt: number; id?: string } = {
      occurredAt: this.latestEventOccurredAt ?? 0,
      ...(this.latestEventId !== undefined ? { id: this.latestEventId } : {}),
    };
    const cursorWatermark: { occurredAt: number; id?: string } = {
      occurredAt: cursor.latestEventOccurredAt,
      ...(cursor.latestEventId !== undefined ? { id: cursor.latestEventId } : {}),
    };

    // The live pipeline has advanced past the point where the continuation
    // cursor was captured: start from the newest page instead.
    if (isNewerCursor(currentWatermark, cursorWatermark)) {
      await this.clearContinuationCursor();
      return undefined;
    }

    return cursor.cursor;
  }

  private async run(reason: ActivitySyncReason): Promise<SyncRunResult> {
    const startedAt = this.now();
    this.setState({ status: 'syncing', reason, startedAt });

    // Bounded recovery window. The lower bound is the newest-known watermark
    // MINUS an overlap window (so events that arrived slightly out of order on
    // the live stream are re-examined and deduplicated by the repository), but
    // never further back than maxGapMs from now on a cold start.
    const floorMs = startedAt - this.maxGapMs;
    const watermarkMs = this.latestEventOccurredAt ?? 0;
    const boundMs = Math.max(
      watermarkMs > 0 ? watermarkMs - this.overlapMs : 0,
      floorMs,
    );

    let recovered = 0;
    let pages = 0;
    // Internal pagination cursor from the history API. A fresh run starts from
    // the newest page; if a previous run stopped due to bounded pagination and
    // the watermark has not advanced past it, we resume from the stored cursor.
    // Avoid an unnecessary await when storage is absent so the first history
    // request is issued synchronously (tests rely on this timing).
    let cursor: string | undefined;

    if (this.deps.storage !== undefined) {
      cursor = await this.loadContinuationCursor();
    }

    let hitBoundary = false;
    let exhausted = false;
    let newestInserted: { occurredAt: number; id: string } | undefined;

    try {
      while (pages < this.maxPages && !hitBoundary && !exhausted) {
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

        // Read the FULL page before deciding anything (out-of-order safety): a
        // page may mix above-bound and at/below-bound events (same-millisecond
        // ties sort arbitrarily), so the boundary verdict comes only after
        // scanning every event, and only then do we stop pagination.
        let pageHasBoundary = false;

        for (const event of result.events) {
          if (this.isAtOrBelowBound(event, boundMs)) {
            pageHasBoundary = true;
            continue;
          }

          // The ingestor runs the same insert -> broadcast -> enrichment tail
          // as live events (provisional-mapping diagnostics and health records
          // included), with toast forced on. A duplicate id returns
          // 'duplicate' — skipped with no broadcast, no count — and the stored
          // row (annotations, mutes, unread state) is untouched.
          const outcome = await this.deps.ingestor.ingestRecovered(event);

          if (outcome.status === 'inserted') {
            recovered += 1;

            if (newestInserted === undefined || isNewerComposite(event, newestInserted)) {
              newestInserted = event;
            }
          }
        }

        if (pageHasBoundary) {
          hitBoundary = true;
        } else if (result.nextCursor === undefined) {
          exhausted = true;
        } else {
          cursor = result.nextCursor;
        }
      }

      if (!hitBoundary && !exhausted) {
        // maxPages reached with the lower bound never seen and more pages
        // still available: the backfill is incomplete. Report a retryable
        // failure and persist a continuation cursor so the next run resumes
        // from page maxPages + 1 instead of restarting from the newest page.
        // The watermark cursor is intentionally NOT advanced or persisted.
        if (cursor !== undefined) {
          await this.persistContinuationCursor(cursor);
        }

        this.setState({ status: 'failed', retryable: true, finishedAt: this.now() });
        return { status: 'failed', reason: 'bounded-pagination' };
      }
    } catch (error) {
      // Unexpected (storage/broadcast) failure: never leave the state stuck
      // on 'syncing', but still surface the error so the background root can
      // record its storage_failure diagnostic.
      this.setState({ status: 'failed', retryable: false, finishedAt: this.now() });
      throw error;
    }

    const finishedAt = this.now();

    // Advance the watermark ONLY for events actually inserted. Failed runs
    // returned above, so this line is reached only on success.
    if (newestInserted !== undefined) {
      this.observeEvent(newestInserted);
    }

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

    // The run completed successfully: the continuation cursor (if any) is
    // consumed and the composite recovery cursor is advanced.
    await this.clearContinuationCursor();

    // Persist the composite recovery cursor: only a successful run writes it.
    await this.persistCursor(finishedAt);

    return { status: 'completed', recovered, pages };
  }
}
