import { z } from 'zod';

import {
  ACTIVITY_REJECTION_STAGES,
  UNKNOWN_NETWORK_AGGREGATE_LIMIT,
  activityRejectionStageEventSchema,
  unknownNetworkAggregateSchema,
  type ActivityRejectionStage,
  type UnknownNetworkAggregate,
} from './diagnostics';

export type { ActivityRejectionStage, UnknownNetworkAggregate };
export { UNKNOWN_NETWORK_AGGREGATE_LIMIT };

export const PIPELINE_HEALTH_STORAGE_KEY = 'pipelineHealth.v1';

export type PipelineRejectionCode =
  | 'schema_invalid'
  | 'duplicate'
  | 'storage_failed'
  | 'broadcast_failed';

export interface PipelineHealthSnapshotV1 {
  schemaVersion: 1;
  observerInstalled: boolean;
  socketObserved: boolean;
  socketOpen: boolean;
  lastFrameAt?: number;
  lastCandidateAt?: number;
  lastPersistedAt?: number;
  latestEventOccurredAt?: number;
  activityCandidates: number;
  accepted: number;
  rejected: number;
  duplicates: number;
  schemaRejections?: number;
  storageFailures?: number;
  broadcastFailures?: number;
  persisted: number;
  broadcasts: number;
  lastRejectionCode?: PipelineRejectionCode;
  lastRejectedAt?: number;
  /**
   * Bounded per-stage rejection counters (plan Task 2). Only the seven closed
   * stage codes may appear as keys; hostile keys are rejected by the schema.
   */
  rejectionStages?: Partial<Record<ActivityRejectionStage, number>>;
  /** Bounded evidence for network IDs the catalog does not know (Task 2). */
  unknownNetworkAggregates?: UnknownNetworkAggregate[];
  /** Most recent closed rejection stage at any pipeline boundary (Task 2). */
  lastRejectionStage?: ActivityRejectionStage;
  /**
   * Events recovered from the authenticated history adapter (Task 4). Present
   * only after at least one bounded recovery run inserted rows; a run that
   * finds nothing new never touches it.
   */
  recovered?: number;
}

export type PipelineHealthEvent =
  | { type: 'observer.installed' }
  | { type: 'socket.observed'; at: number }
  | { type: 'socket.opened'; at: number }
  | { type: 'socket.closed'; at: number }
  | { type: 'frame.received'; at: number }
  | { type: 'activity.candidate'; at: number }
  | { type: 'activity.accepted'; at: number; occurredAt: number }
  | { type: 'activity.persisted'; at: number }
  | { type: 'activity.broadcast'; at: number }
  | { type: 'activity.rejected'; code: PipelineRejectionCode; at: number }
  | { type: 'activity.rejectionStage'; stage: ActivityRejectionStage; at: number }
  | { type: 'activity.unknownNetwork'; networkId: number; at: number }
  | { type: 'activity.recovered'; at: number; count: number };

const timestampSchema = z.number().int().nonnegative().finite();
const counterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rejectionCodeSchema = z.enum([
  'schema_invalid',
  'duplicate',
  'storage_failed',
  'broadcast_failed',
]);

const rejectionStageCountsSchema = z.partialRecord(
  z.enum(ACTIVITY_REJECTION_STAGES),
  counterSchema,
);

export const pipelineHealthEventSchema: z.ZodType<PipelineHealthEvent> =
  z.discriminatedUnion('type', [
    z.object({ type: z.literal('observer.installed') }).strict(),
    z.object({ type: z.literal('socket.observed'), at: timestampSchema }).strict(),
    z.object({ type: z.literal('socket.opened'), at: timestampSchema }).strict(),
    z.object({ type: z.literal('socket.closed'), at: timestampSchema }).strict(),
    z.object({ type: z.literal('frame.received'), at: timestampSchema }).strict(),
    z.object({ type: z.literal('activity.candidate'), at: timestampSchema }).strict(),
    z.object({
      type: z.literal('activity.accepted'),
      at: timestampSchema,
      occurredAt: timestampSchema,
    }).strict(),
    z.object({ type: z.literal('activity.persisted'), at: timestampSchema }).strict(),
    z.object({ type: z.literal('activity.broadcast'), at: timestampSchema }).strict(),
    z.object({
      type: z.literal('activity.rejected'),
      code: rejectionCodeSchema,
      at: timestampSchema,
    }).strict(),
    activityRejectionStageEventSchema,
    z.object({
      type: z.literal('activity.unknownNetwork'),
      networkId: z.number().int().nonnegative(),
      at: timestampSchema,
    }).strict(),
    z.object({
      type: z.literal('activity.recovered'),
      at: timestampSchema,
      count: counterSchema,
    }).strict(),
  ]);

export const pipelineHealthSnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    observerInstalled: z.boolean(),
    socketObserved: z.boolean(),
    socketOpen: z.boolean(),
    lastFrameAt: timestampSchema.optional(),
    lastCandidateAt: timestampSchema.optional(),
    lastPersistedAt: timestampSchema.optional(),
    latestEventOccurredAt: timestampSchema.optional(),
    activityCandidates: counterSchema,
    accepted: counterSchema,
    rejected: counterSchema,
    duplicates: counterSchema,
    schemaRejections: counterSchema.optional(),
    storageFailures: counterSchema.optional(),
    broadcastFailures: counterSchema.optional(),
    persisted: counterSchema,
    broadcasts: counterSchema,
    lastRejectionCode: rejectionCodeSchema.optional(),
    lastRejectedAt: timestampSchema.optional(),
    rejectionStages: rejectionStageCountsSchema.optional(),
    unknownNetworkAggregates: z
      .array(unknownNetworkAggregateSchema)
      .max(UNKNOWN_NETWORK_AGGREGATE_LIMIT)
      .optional(),
    lastRejectionStage: z.enum(ACTIVITY_REJECTION_STAGES).optional(),
    recovered: counterSchema.optional(),
  })
  .strict();

export function parsePipelineHealthSnapshot(
  value: unknown,
): PipelineHealthSnapshotV1 | undefined {
  const result = pipelineHealthSnapshotSchema.safeParse(value);
  if (!result.success) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(result.data).filter(([, entry]) => entry !== undefined),
  ) as unknown as PipelineHealthSnapshotV1;
}

const initialSnapshot = (): PipelineHealthSnapshotV1 => ({
  schemaVersion: 1,
  observerInstalled: false,
  socketObserved: false,
  socketOpen: false,
  activityCandidates: 0,
  accepted: 0,
  rejected: 0,
  duplicates: 0,
  schemaRejections: 0,
  storageFailures: 0,
  broadcastFailures: 0,
  persisted: 0,
  broadcasts: 0,
  rejectionStages: {},
  unknownNetworkAggregates: [],
});

const increment = (value: number): number =>
  value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;

/** Coarse worker rejection codes map onto the finer closed stage model. */
const REJECTION_CODE_TO_STAGE: Readonly<
  Record<PipelineRejectionCode, ActivityRejectionStage>
> = {
  schema_invalid: 'raw-schema',
  duplicate: 'deduplication',
  storage_failed: 'storage',
  broadcast_failed: 'broadcast',
};

export class PipelineHealthState {
  private state: PipelineHealthSnapshotV1;

  constructor(
    private readonly now: () => number,
    restored?: PipelineHealthSnapshotV1,
  ) {
    this.state = restored === undefined ? initialSnapshot() : { ...restored };
  }

  record(event: PipelineHealthEvent): void {
    switch (event.type) {
      case 'observer.installed':
        this.state.observerInstalled = true;
        return;
      case 'socket.observed':
        this.state.socketObserved = true;
        return;
      case 'socket.opened':
        this.state.socketObserved = true;
        this.state.socketOpen = true;
        return;
      case 'socket.closed':
        this.state.socketOpen = false;
        return;
      case 'frame.received':
        this.state.lastFrameAt = event.at;
        return;
      case 'activity.candidate':
        this.state.activityCandidates = increment(this.state.activityCandidates);
        this.state.lastCandidateAt = event.at;
        return;
      case 'activity.accepted':
        this.state.accepted = increment(this.state.accepted);
        this.state.latestEventOccurredAt = Math.max(
          this.state.latestEventOccurredAt ?? 0,
          event.occurredAt,
        );
        return;
      case 'activity.persisted':
        this.state.persisted = increment(this.state.persisted);
        this.state.lastPersistedAt = event.at;
        return;
      case 'activity.broadcast':
        this.state.broadcasts = increment(this.state.broadcasts);
        return;
      case 'activity.rejected':
        this.applyRejection(REJECTION_CODE_TO_STAGE[event.code], event.at, event.code);
        return;
      case 'activity.rejectionStage':
        this.applyRejection(event.stage, event.at);
        return;
      case 'activity.unknownNetwork':
        this.applyUnknownNetwork(event.networkId, event.at);
        return;
      case 'activity.recovered':
        // Adds the run's recovered-event count (a completed run that found
        // nothing new records count 0 and leaves the counter untouched).
        if (event.count > 0) {
          this.state.recovered = Math.min(
            Number.MAX_SAFE_INTEGER,
            (this.state.recovered ?? 0) + event.count,
          );
        }
        return;
    }
  }

  restore(snapshot: PipelineHealthSnapshotV1): void {
    this.state = { ...snapshot };
  }

  /**
   * Records a rejection at one closed pipeline stage. Every rejection — from
   * any boundary — increments the total `rejected` counter, its stage counter,
   * and the legacy coarse counter that maps to that stage. Only the closed
   * stage code, counters, and timestamps are touched; raw candidates never
   * enter this state.
   */
  private applyRejection(
    stage: ActivityRejectionStage,
    at: number,
    code?: PipelineRejectionCode,
  ): void {
    this.state.rejected = increment(this.state.rejected);
    this.state.rejectionStages = {
      ...(this.state.rejectionStages ?? {}),
      [stage]: increment(this.state.rejectionStages?.[stage] ?? 0),
    };
    this.state.lastRejectionStage = stage;
    this.state.lastRejectedAt = at;

    if (code !== undefined) {
      this.state.lastRejectionCode = code;
    }

    if (stage === 'deduplication') {
      this.state.duplicates = increment(this.state.duplicates);
    } else if (stage === 'raw-schema') {
      this.state.schemaRejections = increment(this.state.schemaRejections ?? 0);
    } else if (stage === 'storage') {
      this.state.storageFailures = increment(this.state.storageFailures ?? 0);
    } else if (stage === 'broadcast') {
      this.state.broadcastFailures = increment(this.state.broadcastFailures ?? 0);
    }
  }

  /**
   * Bounded evidence for an unknown network ID: increments the matching
   * aggregate or, once UNKNOWN_NETWORK_AGGREGATE_LIMIT distinct IDs are held,
   * evicts the least-recently-seen ID to make room. Only the numeric ID, a
   * saturating counter, and the last-seen timestamp are stored.
   */
  private applyUnknownNetwork(networkId: number, at: number): void {
    const current = this.state.unknownNetworkAggregates ?? [];
    const existingIndex = current.findIndex(
      (entry) => entry.networkId === networkId,
    );

    if (existingIndex !== -1) {
      const existing = current[existingIndex];

      if (existing === undefined) {
        return;
      }

      const next = [...current];
      next[existingIndex] = {
        networkId,
        count: increment(existing.count),
        lastSeenAt: Math.max(existing.lastSeenAt, at),
      };
      this.state.unknownNetworkAggregates = next;
      return;
    }

    const aggregate: UnknownNetworkAggregate = {
      networkId,
      count: 1,
      lastSeenAt: at,
    };

    if (current.length < UNKNOWN_NETWORK_AGGREGATE_LIMIT) {
      this.state.unknownNetworkAggregates = [...current, aggregate];
      return;
    }

    let oldestIndex = 0;

    for (let index = 1; index < current.length; index += 1) {
      const entry = current[index];
      const oldest = current[oldestIndex];

      if (entry !== undefined && oldest !== undefined && entry.lastSeenAt < oldest.lastSeenAt) {
        oldestIndex = index;
      }
    }

    const next = [...current];
    next[oldestIndex] = aggregate;
    this.state.unknownNetworkAggregates = next;
  }

  /**
   * Returns a defensive copy: the nested rejectionStages map and
   * unknownNetworkAggregates array are copied so callers can never mutate the
   * live state through a returned snapshot.
   */
  snapshot(): PipelineHealthSnapshotV1 {
    return {
      ...this.state,
      ...(this.state.rejectionStages !== undefined
        ? { rejectionStages: { ...this.state.rejectionStages } }
        : {}),
      ...(this.state.unknownNetworkAggregates !== undefined
        ? {
            unknownNetworkAggregates: this.state.unknownNetworkAggregates.map(
              (entry) => ({ ...entry }),
            ),
          }
        : {}),
    };
  }
}

export interface PipelineHealthStorage {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function readPipelineHealth(
  storage: PipelineHealthStorage,
): Promise<PipelineHealthSnapshotV1 | undefined> {
  const stored = await storage.get(PIPELINE_HEALTH_STORAGE_KEY);
  return parsePipelineHealthSnapshot(stored[PIPELINE_HEALTH_STORAGE_KEY]);
}

export async function writePipelineHealth(
  storage: PipelineHealthStorage,
  snapshot: PipelineHealthSnapshotV1,
): Promise<void> {
  const parsed = parsePipelineHealthSnapshot(snapshot);
  if (parsed === undefined) {
    throw new TypeError('invalid pipeline health snapshot');
  }
  await storage.set({ [PIPELINE_HEALTH_STORAGE_KEY]: parsed });
}

export interface PersistedPipelineHealthOptions {
  storage: PipelineHealthStorage;
  now: () => number;
  onStorageFailure(error: unknown): void;
}

/**
 * Coordinates restoration, mutations, queries, and serialized persistence.
 * Every public operation crosses the same readiness gate, so a delayed
 * session read can never overwrite worker-startup events or expose a
 * temporary empty snapshot. Failed writes are observability failures only;
 * they never alter business counters, and the queue remains usable.
 */
export class PersistedPipelineHealth {
  private readonly state: PipelineHealthState;
  private readonly ready: Promise<void>;
  private pendingSnapshot: PipelineHealthSnapshotV1 | undefined;
  private writeInFlight: Promise<void> | null = null;

  constructor(private readonly options: PersistedPipelineHealthOptions) {
    this.state = new PipelineHealthState(options.now);
    this.ready = readPipelineHealth(options.storage)
      .then((restored) => {
        if (restored !== undefined) {
          this.state.restore(restored);
        }
      })
      .catch((error: unknown) => {
        options.onStorageFailure(error);
      });
  }

  async record(event: PipelineHealthEvent): Promise<void> {
    await this.ready;
    this.state.record(event);
    this.pendingSnapshot = this.state.snapshot();
    await this.ensureWrite();
  }

  async snapshot(): Promise<PipelineHealthSnapshotV1> {
    await this.ready;
    return this.state.snapshot();
  }

  /** Test/shutdown seam; record already waits for its persistence drain. */
  async flush(): Promise<void> {
    await this.ready;
    if (this.writeInFlight !== null) {
      await this.writeInFlight;
    }
  }

  private ensureWrite(): Promise<void> {
    if (this.writeInFlight === null) {
      this.writeInFlight = this.drainWrites();
    }

    return this.writeInFlight;
  }

  private async drainWrites(): Promise<void> {
    while (this.pendingSnapshot !== undefined) {
      const snapshot = this.pendingSnapshot;
      this.pendingSnapshot = undefined;

      try {
        await writePipelineHealth(this.options.storage, snapshot);
      } catch (error) {
        this.options.onStorageFailure(error);
      }
    }

    // Clear ownership before this async function settles. There is no await
    // between the final pending check above and this assignment, so a later
    // record either contributed to this drain or observes null and starts a
    // new owner; it can never reuse a settled promise.
    this.writeInFlight = null;
  }
}
