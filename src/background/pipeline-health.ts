import { z } from 'zod';

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
  persisted: number;
  broadcasts: number;
  lastRejectionCode?: PipelineRejectionCode;
  lastRejectedAt?: number;
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
  | { type: 'activity.rejected'; code: PipelineRejectionCode; at: number };

const timestampSchema = z.number().int().nonnegative().finite();
const counterSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const rejectionCodeSchema = z.enum([
  'schema_invalid',
  'duplicate',
  'storage_failed',
  'broadcast_failed',
]);

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
    persisted: counterSchema,
    broadcasts: counterSchema,
    lastRejectionCode: rejectionCodeSchema.optional(),
    lastRejectedAt: timestampSchema.optional(),
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
  persisted: 0,
  broadcasts: 0,
});

const increment = (value: number): number =>
  value >= Number.MAX_SAFE_INTEGER ? Number.MAX_SAFE_INTEGER : value + 1;

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
        this.state.rejected = increment(this.state.rejected);
        if (event.code === 'duplicate') {
          this.state.duplicates = increment(this.state.duplicates);
        }
        this.state.lastRejectionCode = event.code;
        this.state.lastRejectedAt = event.at;
    }
  }

  restore(snapshot: PipelineHealthSnapshotV1): void {
    this.state = { ...snapshot };
  }

  snapshot(): PipelineHealthSnapshotV1 {
    return { ...this.state };
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

  /** Test/shutdown seam; normal event handling does not wait on session I/O. */
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
