import type { TradeEventV1 } from '../domain/activity';
import type { TraderMetricSource } from '../fomo/enrichment-client';
import { getNetworkMapping } from '../fomo/network-map';
import { normalizeActivity } from '../fomo/normalize';
import { rawActivitySchema } from '../fomo/raw-schema';
import type {
  ActivityBroadcastMessage,
} from '../messaging/protocol';
import type { DiagnosticRecorder } from './diagnostics';
import type { PipelineHealthState } from './pipeline-health';
import type { LiveBuyNotifier } from './buy-sound';

export type { ActivityBroadcastMessage as BroadcastActivityMessage } from '../messaging/protocol';

/**
 * Activity ingest use case (plan Task 7 Step 1).
 *
 * The EXACT order is: normalize -> insert -> immediate broadcast -> cached
 * enrichment lookup -> optional event update.
 *
 * - A duplicate insert (EventRepository.insert returning false) skips BOTH
 *   the broadcast and the enrichment.
 * - An invalid payload increments a BOUNDED rejection counter and records a
 *   redacted schema_rejection diagnostic — the raw payload is never stored.
 * - The broadcast is IMMEDIATE after persistence and never gated on settings
 *   or annotation reads.
 * - Enrichment never blocks or delays the base-event broadcast: it starts
 *   only after the broadcast resolves, runs as a detached task whose failures
 *   are recorded as redacted enrichment_failure diagnostics, and is bounded by
 *   a real fetch timeout (AbortSignal.timeout) so a hung endpoint cannot keep
 *   the MV3 worker alive or die mid-flight.
 * - Events normalized through a PROVISIONAL network mapping record a
 *   provisional_network_mapping diagnostic (src/fomo/network-map.ts exposes
 *   the status).
 * - ingestRecovered() persists an ALREADY-normalized TradeEventV1 (a row the
 *   history adapter produced through normalizeActivity) through the SAME
 *   insert -> broadcast -> enrichment tail: provisional-mapping diagnostics,
 *   health records, and detached enrichment all match the live path. It
 *   bypasses raw-schema validation and canonical normalization (the history
 *   client already ran them).
 *
 * MV3 note: the rejection counter is intentionally in-memory. It is
 * diagnostic-grade observability, not correctness state, so losing it on a
 * worker suspension is acceptable.
 */

export const DEFAULT_ENRICHMENT_TIMEOUT_MS = 10_000;

export interface ActivityIngestDependencies {
  events: {
    insert(event: TradeEventV1): Promise<boolean>;
    update(id: string, changes: Partial<TradeEventV1>): Promise<number>;
  };
  diagnostics: Pick<DiagnosticRecorder, 'record'>;
  rejections: RejectionCounter;
  metricSource: TraderMetricSource;
  broadcast(message: ActivityBroadcastMessage): void | Promise<void>;
  health?: {
    record(event: Parameters<PipelineHealthState['record']>[0]): void | Promise<void>;
  };
  liveBuyNotifier?: LiveBuyNotifier;
  /** Overridable for tests; defaults to DEFAULT_ENRICHMENT_TIMEOUT_MS. */
  enrichmentTimeoutMs?: number;
}

export type IngestOutcome =
  | { status: 'rejected' }
  | { status: 'duplicate'; event: TradeEventV1 }
  | { status: 'inserted'; event: TradeEventV1; enrichment: Promise<void> };

export const MAX_REJECTION_COUNT = 10_000;

export interface RejectionCounter {
  increment(): void;
  value(): number;
}

export function createRejectionCounter(max = MAX_REJECTION_COUNT): RejectionCounter {
  if (!Number.isInteger(max) || max <= 0) {
    throw new TypeError('max must be a positive integer');
  }

  let count = 0;

  return {
    increment(): void {
      if (count < max) {
        count += 1;
      }
    },
    value(): number {
      return count;
    },
  };
}

const REQUIRED_RAW_FIELDS = [
  'type',
  'userId',
  'userHandle',
  'ticker',
  'tokenAddress',
  'networkId',
  'createdAt',
] as const;

/**
 * Best-effort missing-field report for the redacted schema_rejection
 * diagnostic. Only allowlisted raw-activity field names are returned; the
 * DiagnosticRecorder sanitizes them again before storage.
 */
export function deriveMissingFields(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return [...REQUIRED_RAW_FIELDS];
  }

  const record = payload as Record<string, unknown>;

  return REQUIRED_RAW_FIELDS.filter((name) => {
    const value = record[name];

    if (name === 'networkId') {
      return typeof value !== 'number';
    }

    return typeof value !== 'string' || value.trim().length === 0;
  });
}

export class ActivityIngestor {
  private readonly enrichmentTimeoutMs: number;

  constructor(private readonly deps: ActivityIngestDependencies) {
    this.enrichmentTimeoutMs =
      deps.enrichmentTimeoutMs ?? DEFAULT_ENRICHMENT_TIMEOUT_MS;

    if (!Number.isFinite(this.enrichmentTimeoutMs) || this.enrichmentTimeoutMs <= 0) {
      throw new TypeError('enrichmentTimeoutMs must be a positive finite number');
    }
  }

  async ingest(input: { payload: unknown; receivedAt: number }): Promise<IngestOutcome> {
    let event: TradeEventV1;

    // Raw-schema gate (plan Task 2): an unknown network ID increments its
    // bounded aggregate AFTER raw schema validation and BEFORE canonical
    // normalization. The double parse is deliberate — the raw schema is the
    // only place the numeric networkId is trustworthy, and the aggregate
    // records just the ID, a counter, and a timestamp, never the candidate.
    const rawResult = rawActivitySchema.safeParse(input.payload);

    if (rawResult.success) {
      const networkId = rawResult.data.networkId;

      if (
        Number.isInteger(networkId) &&
        networkId >= 0 &&
        getNetworkMapping(networkId) === null
      ) {
        await this.deps.health?.record({
          type: 'activity.unknownNetwork',
          networkId,
          at: input.receivedAt,
        });
      }
    }

    try {
      event = await normalizeActivity(input.payload, input.receivedAt);
    } catch {
      // The raw schema gate above decides the stage: a payload that passed it
      // but still failed normalization is a normalization-stage rejection;
      // anything else is a raw-schema rejection. Only the closed stage code
      // and timestamp are recorded — the raw candidate is never stored.
      if (rawResult.success) {
        await this.deps.health?.record({
          type: 'activity.rejectionStage',
          stage: 'normalization',
          at: input.receivedAt,
        });
      } else {
        await this.deps.health?.record({
          type: 'activity.rejected',
          code: 'schema_invalid',
          at: input.receivedAt,
        });
      }

      this.deps.rejections.increment();

      const missingFields = deriveMissingFields(input.payload);

      this.deps.diagnostics.record({
        code: 'schema_rejection',
        schemaVersion: 1,
        messageType: 'activity.ingest',
        ...(missingFields.length > 0 ? { missingFields } : {}),
      });

      return { status: 'rejected' };
    }

    await this.deps.health?.record({
      type: 'activity.accepted',
      at: input.receivedAt,
      occurredAt: event.occurredAt,
    });

    return this.persistAndBroadcast(event, input.receivedAt, true);
  }

  /**
   * Persists an already-normalized recovered event (a TradeEventV1 produced by
   * the history adapter's normalizeHistoryPage) through the exact same
   * insert -> broadcast -> enrichment path as live events. Bypasses raw-schema
   * validation and canonical normalization — the history client already ran
   * normalizeActivity over the whole page — but records the same health events
   * and provisional-network-mapping diagnostics.
   */
  async ingestRecovered(event: TradeEventV1): Promise<IngestOutcome> {
    await this.deps.health?.record({
      type: 'activity.accepted',
      at: event.receivedAt,
      occurredAt: event.occurredAt,
    });

    return this.persistAndBroadcast(event, event.receivedAt);
  }

  /**
   * Shared tail of ingest/ingestRecovered, in the pipeline's EXACT order:
   * provisional-mapping diagnostic -> insert -> broadcast -> detached
   * enrichment. A duplicate insert returns 'duplicate'
   * (no broadcast, no enrichment); a failed broadcast records the rejection
   * and throws, exactly like the live path.
   */
  private async persistAndBroadcast(
    event: TradeEventV1,
    receivedAt: number,
    notifyLiveBuy = false,
  ): Promise<IngestOutcome> {
    const mapping =
      event.networkId === undefined ? null : getNetworkMapping(event.networkId);

    if (mapping !== null && mapping.status === 'provisional-unverified') {
      this.deps.diagnostics.record({
        code: 'provisional_network_mapping',
        schemaVersion: 1,
        messageType: 'activity.ingest',
      });
    }

    let inserted: boolean;
    try {
      inserted = await this.deps.events.insert(event);
    } catch (error) {
      await this.deps.health?.record({
        type: 'activity.rejected',
        code: 'storage_failed',
        at: receivedAt,
      });
      throw error;
    }

    if (!inserted) {
      await this.deps.health?.record({
        type: 'activity.rejected',
        code: 'duplicate',
        at: receivedAt,
      });
      return { status: 'duplicate', event };
    }

    await this.deps.health?.record({ type: 'activity.persisted', at: receivedAt });

    if (notifyLiveBuy && event.action === 'buy') {
      try {
        this.deps.liveBuyNotifier?.notify(event);
      } catch {
        // Sound is best effort and must not affect broadcast or enrichment.
      }
    }

    // Immediate broadcast (plan order). No preference storage read is needed
    // or awaited on the Side Panel-only delivery path.
    try {
      await this.deps.broadcast({
        protocolVersion: 1,
        type: 'activity.broadcast',
        payload: { event },
      });
      await this.deps.health?.record({ type: 'activity.broadcast', at: receivedAt });
    } catch (error) {
      await this.deps.health?.record({
        type: 'activity.rejected',
        code: 'broadcast_failed',
        at: receivedAt,
      });
      throw error;
    }

    // Detached on purpose: enrichment must never delay or block the base
    // broadcast, and a hanging or failing enrichment must not reject ingest.
    const enrichment = this.enrich(event);

    return { status: 'inserted', event, enrichment };
  }

  private async enrich(event: TradeEventV1): Promise<void> {
    try {
      const snapshot = await this.deps.metricSource.fetch7dMetrics(
        event.traderId,
        AbortSignal.timeout(this.enrichmentTimeoutMs),
      );

      if (snapshot !== null) {
        await this.deps.events.update(event.id, { metricSnapshot: snapshot });
      }
    } catch {
      this.deps.diagnostics.record({
        code: 'enrichment_failure',
        messageType: 'activity.ingest',
      });
    }
  }
}
