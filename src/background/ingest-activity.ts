import type { TraderAnnotationV1 } from '../domain/annotations';
import { DEFAULT_SETTINGS, type LocalSettingsV3 } from '../domain/settings';
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
 * - The broadcast is IMMEDIATE and NEVER gated on storage reads: the toast
 *   suppression verdict (muted trader, muted chain, minimumUsdAmount) comes
 *   from a cached snapshot of settings and annotations (ToastSuppressionCache)
 *   that is seeded at worker bootstrap and refreshed in the background after
 *   every broadcast. Two chrome.storage.local round-trips never delay a toast,
 *   and a rejected read can never prevent the broadcast: the cache falls back
 *   to the previous snapshot (or safe defaults) until the refresh lands. A
 *   suppressed event is still broadcast with toast:false — the overlay keeps
 *   history and just shows no card.
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
 *   client already ran them) and never consults the suppression cache:
 *   recovered events always broadcast with toast: true — they were missed
 *   while the socket was disconnected.
 *
 * MV3 note: the rejection counter and the suppression cache are intentionally
 * in-memory. The rejection counter is diagnostic-grade observability, not
 * correctness state, so losing it on a worker suspension is acceptable. The
 * suppression cache is re-seeded from storage at every worker bootstrap, so
 * it converges to fresh settings/annotations after each restart.
 */

export const DEFAULT_ENRICHMENT_TIMEOUT_MS = 10_000;

export interface ActivityIngestDependencies {
  events: {
    insert(event: TradeEventV1): Promise<boolean>;
    update(id: string, changes: Partial<TradeEventV1>): Promise<number>;
  };
  preferences: {
    getSettings(): Promise<LocalSettingsV3>;
    listAnnotations(): Promise<TraderAnnotationV1[]>;
  };
  diagnostics: Pick<DiagnosticRecorder, 'record'>;
  rejections: RejectionCounter;
  metricSource: TraderMetricSource;
  broadcast(message: ActivityBroadcastMessage): void | Promise<void>;
  health?: {
    record(event: Parameters<PipelineHealthState['record']>[0]): void | Promise<void>;
  };
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

/**
 * Decides whether a new event should surface as a toast. Suppression (muted
 * trader, muted chain, below the minimum USD amount) only affects the toast:
 * the event is persisted and broadcast either way.
 */
export function shouldToast(
  event: TradeEventV1,
  settings: LocalSettingsV3,
  annotation: TraderAnnotationV1 | undefined,
): boolean {
  if (annotation?.muted === true) {
    return false;
  }

  if (settings.filters.mutedChains.includes(event.chain)) {
    return false;
  }

  const minimumUsdAmount = settings.filters.minimumUsdAmount;

  if (
    minimumUsdAmount !== undefined &&
    (event.usdAmount === undefined || event.usdAmount < minimumUsdAmount)
  ) {
    return false;
  }

  return true;
}

/**
 * Cached toast-suppression source. Seed it at worker bootstrap (and refresh it
 * on preferences.changed) so the broadcast's toast flag NEVER waits on a
 * storage read. A failed refresh keeps the previous snapshot; the very first
 * broadcast on a cold worker falls back to DEFAULT_SETTINGS plus no
 * annotations (a safe default that errs toward showing the base event).
 */
export class ToastSuppressionCache {
  private settings: LocalSettingsV3 = DEFAULT_SETTINGS;
  private annotations = new Map<string, TraderAnnotationV1>();
  private refreshing: Promise<void> | null = null;

  constructor(
    private readonly preferences: ActivityIngestDependencies['preferences'],
  ) {}

  shouldToast(event: TradeEventV1): boolean {
    return shouldToast(event, this.settings, this.annotations.get(event.traderId));
  }

  /**
   * Re-reads settings and annotations without ever throwing to the caller;
   * rejected reads keep the previous snapshot. Concurrent callers share one
   * in-flight refresh.
   */
  refresh(): Promise<void> {
    if (this.refreshing !== null) {
      return this.refreshing;
    }

    this.refreshing = Promise.allSettled([
      this.preferences.getSettings(),
      this.preferences.listAnnotations(),
    ])
      .then(([settingsResult, annotationsResult]) => {
        if (settingsResult.status === 'fulfilled') {
          this.settings = settingsResult.value;
        }

        if (annotationsResult.status === 'fulfilled') {
          const next = new Map<string, TraderAnnotationV1>();

          for (const annotation of annotationsResult.value) {
            next.set(annotation.traderId, annotation);
          }

          this.annotations = next;
        }
      })
      .finally(() => {
        this.refreshing = null;
      });

    return this.refreshing;
  }
}

export class ActivityIngestor {
  private readonly suppression: ToastSuppressionCache;
  private readonly enrichmentTimeoutMs: number;

  constructor(private readonly deps: ActivityIngestDependencies) {
    this.suppression = new ToastSuppressionCache(deps.preferences);
    this.enrichmentTimeoutMs =
      deps.enrichmentTimeoutMs ?? DEFAULT_ENRICHMENT_TIMEOUT_MS;

    if (!Number.isFinite(this.enrichmentTimeoutMs) || this.enrichmentTimeoutMs <= 0) {
      throw new TypeError('enrichmentTimeoutMs must be a positive finite number');
    }
  }

  /**
   * Seeds the suppression cache from storage. Called at worker bootstrap so
   * the FIRST event's toast flag already reflects stored settings and
   * annotations; rejected reads degrade silently to the previous snapshot.
   */
  async warmSuppression(): Promise<void> {
    await this.suppression.refresh();
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

    return this.persistAndBroadcast(
      event,
      input.receivedAt,
      this.suppression.shouldToast(event),
    );
  }

  /**
   * Persists an already-normalized recovered event (a TradeEventV1 produced by
   * the history adapter's normalizeHistoryPage) through the exact same
   * insert -> broadcast -> enrichment path as live events. Bypasses raw-schema
   * validation and canonical normalization — the history client already ran
   * normalizeActivity over the whole page — but records the same health events
   * and provisional-network-mapping diagnostics. Recovered events ALWAYS
   * broadcast with toast: true: they were missed while the socket was
   * disconnected, so the cached suppression snapshot never applies.
   */
  async ingestRecovered(event: TradeEventV1): Promise<IngestOutcome> {
    await this.deps.health?.record({
      type: 'activity.accepted',
      at: event.receivedAt,
      occurredAt: event.occurredAt,
    });

    return this.persistAndBroadcast(event, event.receivedAt, true);
  }

  /**
   * Shared tail of ingest/ingestRecovered, in the pipeline's EXACT order:
   * provisional-mapping diagnostic -> insert -> broadcast -> suppression-cache
   * refresh -> detached enrichment. A duplicate insert returns 'duplicate'
   * (no broadcast, no enrichment); a failed broadcast records the rejection
   * and throws, exactly like the live path.
   */
  private async persistAndBroadcast(
    event: TradeEventV1,
    receivedAt: number,
    toast: boolean,
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

    // Immediate broadcast (plan order): the toast flag comes from the caller
    // (the cached suppression snapshot for live events, always true for
    // recovered events). No storage read is awaited here, so a slow or
    // failing preferences read can neither delay nor block the broadcast.
    try {
      await this.deps.broadcast({
        protocolVersion: 1,
        type: 'activity.broadcast',
        payload: {
          event,
          toast,
        },
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

    // Background refresh keeps the suppression snapshot fresh for the NEXT
    // event; refresh() never rejects, and a failure here must never affect
    // the already-delivered broadcast.
    void this.suppression.refresh().catch(() => {});

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
