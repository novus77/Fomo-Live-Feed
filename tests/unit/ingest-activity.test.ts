import 'fake-indexeddb/auto';

import { afterEach, describe, expect, it } from 'vitest';

import type { TraderAnnotationV1 } from '../../src/domain/annotations';
import type { ChainKey, MetricSnapshotV1, TradeEventV1 } from '../../src/domain/activity';
import { DEFAULT_SETTINGS, type LocalSettingsV4 } from '../../src/domain/settings';
import { DiagnosticRecorder } from '../../src/background/diagnostics';
import { PipelineHealthState } from '../../src/background/pipeline-health';
import {
  ActivityIngestor,
  createRejectionCounter,
  MAX_REJECTION_COUNT,
  shouldToast,
  type BroadcastActivityMessage,
} from '../../src/background/ingest-activity';
import { CachedTraderMetricSource } from '../../src/fomo/enrichment-client';
import { FomoFeedDatabase } from '../../src/storage/database';
import { MetricRepository } from '../../src/storage/metric-repository';
import { buyFrame } from '../fixtures/fomo-frames';

const RECEIVED_AT = 1_800_000_000_001;
const DIAGNOSTIC_AT = 1_700_000_000_000;

const LEADERBOARD_SNAPSHOT: MetricSnapshotV1 = {
  fetchedAt: 1_800_000_000_000,
  source: 'fomo-leaderboard',
  pnl7d: 500,
  winRate7d: 55,
  followers: 1234,
};

type SourceBehavior = MetricSnapshotV1 | null | 'hang' | 'hang-until-abort' | 'reject';

const createEventsFake = (order: string[]) => {
  const stored = new Map<string, TradeEventV1>();

  return {
    stored,
    async insert(event: TradeEventV1): Promise<boolean> {
      order.push('insert');

      if (stored.has(event.id)) {
        return false;
      }

      stored.set(event.id, event);
      return true;
    },
    async update(id: string, changes: Partial<TradeEventV1>): Promise<number> {
      order.push('update');
      const existing = stored.get(id);

      if (existing === undefined) {
        return 0;
      }

      stored.set(id, { ...existing, ...changes });
      return 1;
    },
  };
};

const createPreferencesFake = (options: {
  settings?: LocalSettingsV4;
  annotation?: TraderAnnotationV1;
  rejectReads?: boolean;
} = {}) => {
  const settings = options.settings ?? DEFAULT_SETTINGS;
  const annotation = options.annotation;

  return {
    async getSettings(): Promise<LocalSettingsV4> {
      if (options.rejectReads === true) {
        throw new Error('storage.local read failed');
      }

      return settings;
    },
    async listAnnotations(): Promise<TraderAnnotationV1[]> {
      if (options.rejectReads === true) {
        throw new Error('storage.local read failed');
      }

      return annotation !== undefined ? [annotation] : [];
    },
  };
};

const createSourceFake = (order: string[]) => {
  let behavior: SourceBehavior = null;
  let abortCount = 0;

  return {
    abortCount(): number {
      return abortCount;
    },
    setBehavior(next: SourceBehavior): void {
      behavior = next;
    },
    async fetch7dMetrics(
      _traderId: string,
      signal: AbortSignal,
    ): Promise<MetricSnapshotV1 | null> {
      order.push('fetch');

      if (behavior === 'hang') {
        return new Promise<MetricSnapshotV1 | null>(() => {});
      }

      if (behavior === 'hang-until-abort') {
        return new Promise<MetricSnapshotV1 | null>((resolve) => {
          signal.addEventListener('abort', () => {
            abortCount += 1;
            // Mirrors the real source: a timed-out fetch degrades to null.
            resolve(null);
          });
        });
      }

      if (behavior === 'reject') {
        throw new Error('enrichment exploded');
      }

      return behavior;
    },
  };
};

const createBroadcastFake = (order: string[]) => {
  const messages: BroadcastActivityMessage[] = [];

  return {
    messages,
    async broadcast(message: BroadcastActivityMessage): Promise<void> {
      order.push('broadcast');
      messages.push(message);
    },
  };
};

const createHarness = (options: {
  settings?: LocalSettingsV4;
  annotation?: TraderAnnotationV1;
  rejectReads?: boolean;
  enrichmentTimeoutMs?: number;
} = {}) => {
  const order: string[] = [];
  const events = createEventsFake(order);
  const preferences = createPreferencesFake(options);
  const source = createSourceFake(order);
  const broadcast = createBroadcastFake(order);
  const diagnostics = new DiagnosticRecorder({ now: () => DIAGNOSTIC_AT });
  const rejections = createRejectionCounter();
  const health = new PipelineHealthState(() => RECEIVED_AT);
  const ingestor = new ActivityIngestor({
    events,
    preferences,
    diagnostics,
    rejections,
    metricSource: source,
    broadcast: broadcast.broadcast,
    health,
    ...(options.enrichmentTimeoutMs !== undefined
      ? { enrichmentTimeoutMs: options.enrichmentTimeoutMs }
      : {}),
  });

  return { order, events, source, broadcast, diagnostics, rejections, health, ingestor };
};

const openDatabases: FomoFeedDatabase[] = [];

afterEach(async () => {
  await Promise.all(
    openDatabases.splice(0).map(async (database) => {
      database.close();
      await database.delete();
    }),
  );
});

describe('ActivityIngestor', () => {
  it('persists and broadcasts a valid trade with the default relative avatar', async () => {
    const { ingestor, events, broadcast, health } = createHarness();

    const outcome = await ingestor.ingest({
      payload: { ...buyFrame.payload, profilePictureLink: '/fomo-eyes.png' },
      receivedAt: RECEIVED_AT,
    });

    expect(outcome.status).toBe('inserted');
    expect(events.stored.get('fomo:activity-1')?.traderAvatarUrl).toBe(
      'https://fomo.family/fomo-eyes.png',
    );
    expect(broadcast.messages).toHaveLength(1);
    expect(health.snapshot()).toMatchObject({ accepted: 1, rejected: 0, persisted: 1 });
  });

  it('records each accepted, persisted, broadcast, duplicate, and rejected outcome once', async () => {
    const { ingestor, health } = createHarness();

    await ingestor.ingest({ payload: buyFrame.payload, receivedAt: RECEIVED_AT });
    await ingestor.ingest({ payload: buyFrame.payload, receivedAt: RECEIVED_AT + 1 });
    await ingestor.ingest({ payload: { type: 'swap_buy' }, receivedAt: RECEIVED_AT + 2 });

    expect(health.snapshot()).toMatchObject({
      accepted: 2,
      persisted: 1,
      broadcasts: 1,
      duplicates: 1,
      schemaRejections: 1,
      rejected: 2,
      lastRejectionCode: 'schema_invalid',
      lastRejectedAt: RECEIVED_AT + 2,
    });
  });
  it('ingests in the exact order: insert, broadcast, cached lookup, event update', async () => {
    const { order, ingestor, events, broadcast, source } = createHarness();
    source.setBehavior(LEADERBOARD_SNAPSHOT);

    const outcome = await ingestor.ingest({
      payload: buyFrame.payload,
      receivedAt: RECEIVED_AT,
    });

    if (outcome.status !== 'inserted') {
      throw new Error('expected an inserted outcome');
    }

    await outcome.enrichment;

    expect(order).toEqual(['insert', 'broadcast', 'fetch', 'update']);
    expect((broadcast.messages[0]?.payload.event as { id: string } | undefined)?.id).toBe(
      'fomo:activity-1',
    );
    expect(broadcast.messages[0]?.payload.toast).toBe(true);
    expect(events.stored.get('fomo:activity-1')?.metricSnapshot).toEqual(
      LEADERBOARD_SNAPSHOT,
    );
  });

  it('skips both broadcast and enrichment when the insert is a duplicate', async () => {
    const { order, ingestor, broadcast, source } = createHarness();
    source.setBehavior(LEADERBOARD_SNAPSHOT);

    const first = await ingestor.ingest({
      payload: buyFrame.payload,
      receivedAt: RECEIVED_AT,
    });
    const second = await ingestor.ingest({
      payload: buyFrame.payload,
      receivedAt: RECEIVED_AT + 1,
    });

    if (first.status !== 'inserted') {
      throw new Error('expected an inserted outcome');
    }

    expect(second).toEqual({
      status: 'duplicate',
      event: expect.objectContaining({ id: 'fomo:activity-1' }),
    });
    expect(broadcast.messages).toHaveLength(1);
    expect(order).toEqual(['insert', 'broadcast', 'fetch', 'update', 'insert']);

    await first.enrichment;
  });

  it('rejects an invalid payload with a bounded counter and a redacted diagnostic, storing nothing', async () => {
    const { order, ingestor, events, broadcast, diagnostics, rejections } = createHarness();

    const outcome = await ingestor.ingest({
      payload: { type: 'swap_buy', secret: 'hunter2' },
      receivedAt: RECEIVED_AT,
    });

    expect(outcome).toEqual({ status: 'rejected' });
    expect(order).toEqual([]);
    expect(events.stored.size).toBe(0);
    expect(broadcast.messages).toHaveLength(0);
    expect(rejections.value()).toBe(1);
    expect(diagnostics.snapshot()).toEqual([
      {
        code: 'schema_rejection',
        receivedAt: DIAGNOSTIC_AT,
        schemaVersion: 1,
        messageType: 'activity.ingest',
        missingFields: [
          'userId',
          'userHandle',
          'ticker',
          'tokenAddress',
          'networkId',
          'createdAt',
        ],
      },
    ]);
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain('hunter2');
  });

  it('never stores the raw payload for a rejected message', async () => {
    const { ingestor, events, diagnostics } = createHarness();
    const raw = {
      type: 'swap_buy',
      userId: 'trader-1',
      comment: 'a secret thesis nobody should persist',
      networkId: 999999,
    };

    await ingestor.ingest({ payload: raw, receivedAt: RECEIVED_AT });

    expect(events.stored.size).toBe(0);
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain('secret thesis');
  });

  it('bounds the rejection counter at the exported maximum', () => {
    const rejections = createRejectionCounter();

    for (let index = 0; index < MAX_REJECTION_COUNT + 25; index += 1) {
      rejections.increment();
    }

    expect(rejections.value()).toBe(MAX_REJECTION_COUNT);
  });

  it('rejects a non-object payload without touching storage or broadcast', async () => {
    const { ingestor, events, broadcast, rejections } = createHarness();

    for (const payload of [null, 'activity', 42]) {
      await expect(
        ingestor.ingest({ payload, receivedAt: RECEIVED_AT }),
      ).resolves.toEqual({ status: 'rejected' });
    }

    expect(events.stored.size).toBe(0);
    expect(broadcast.messages).toHaveLength(0);
    expect(rejections.value()).toBe(3);
  });

  it('broadcasts the base event even when enrichment never settles', async () => {
    const { order, ingestor, broadcast, events, source } = createHarness();
    source.setBehavior('hang');

    const outcome = await ingestor.ingest({
      payload: buyFrame.payload,
      receivedAt: RECEIVED_AT,
    });

    if (outcome.status !== 'inserted') {
      throw new Error('expected an inserted outcome');
    }

    expect(order).toEqual(['insert', 'broadcast', 'fetch']);
    expect(broadcast.messages).toHaveLength(1);
    expect(events.stored.has('fomo:activity-1')).toBe(true);
  });

  it('keeps the base event when enrichment rejects and records a redacted failure', async () => {
    const { order, ingestor, broadcast, diagnostics, source } = createHarness();
    source.setBehavior('reject');

    const outcome = await ingestor.ingest({
      payload: buyFrame.payload,
      receivedAt: RECEIVED_AT,
    });

    if (outcome.status !== 'inserted') {
      throw new Error('expected an inserted outcome');
    }

    await expect(outcome.enrichment).resolves.toBeUndefined();

    expect(order).toEqual(['insert', 'broadcast', 'fetch']);
    expect(broadcast.messages).toHaveLength(1);
    expect(
      diagnostics.snapshot().some((record) => record.code === 'enrichment_failure'),
    ).toBe(true);
    expect(JSON.stringify(diagnostics.snapshot())).not.toContain('exploded');
  });

  it('reuses the cached enrichment lookup so the same trader is not refetched on every event', async () => {
    const database = new FomoFeedDatabase('ingest-cache-' + crypto.randomUUID());
    openDatabases.push(database);
    const metricRepository = new MetricRepository(database.metrics);
    const order: string[] = [];
    const inner = {
      async fetch7dMetrics(
        _traderId: string,
        _signal: AbortSignal,
      ): Promise<MetricSnapshotV1 | null> {
        order.push('fetch');
        return LEADERBOARD_SNAPSHOT;
      },
    };
    const cachedSource = new CachedTraderMetricSource({
      source: inner,
      cache: metricRepository,
      now: () => 1_800_000_000_000,
      ttlMs: 300_000,
      failureBackoffMs: 60_000,
    });
    const events = createEventsFake(order);
    const broadcast = createBroadcastFake(order);
    const diagnostics = new DiagnosticRecorder({ now: () => DIAGNOSTIC_AT });
    const ingestor = new ActivityIngestor({
      events,
      preferences: createPreferencesFake(),
      diagnostics,
      rejections: createRejectionCounter(),
      metricSource: cachedSource,
      broadcast: broadcast.broadcast,
    });

    const first = await ingestor.ingest({
      payload: buyFrame.payload,
      receivedAt: RECEIVED_AT,
    });

    if (first.status !== 'inserted') {
      throw new Error('expected an inserted outcome');
    }

    // Wait for the first enrichment so its cache put lands before the second
    // ingest consults the (now populated) cache.
    await first.enrichment;

    const second = await ingestor.ingest({
      payload: { ...buyFrame.payload, id: 'activity-2' },
      receivedAt: RECEIVED_AT + 1,
    });

    if (second.status !== 'inserted') {
      throw new Error('expected an inserted outcome');
    }

    await second.enrichment;

    expect(order.filter((entry) => entry === 'fetch')).toHaveLength(1);
    expect(events.stored.get('fomo:activity-1')?.metricSnapshot).toEqual(
      expect.objectContaining({ pnl7d: 500, winRate7d: 55, followers: 1234 }),
    );
    expect(events.stored.get('fomo:activity-2')?.metricSnapshot).toEqual(
      expect.objectContaining({ pnl7d: 500, winRate7d: 55, followers: 1234 }),
    );
  });

  it('does not record a provisional network mapping diagnostic for verified catalogued mappings', async () => {
    const { ingestor, diagnostics } = createHarness();

    await ingestor.ingest({
      payload: { ...buyFrame.payload, id: 'activity-101', networkId: 101 },
      receivedAt: RECEIVED_AT,
    });

    expect(
      diagnostics
        .snapshot()
        .some((record) => record.code === 'provisional_network_mapping'),
    ).toBe(false);
  });

  it('does not record a provisional diagnostic for the default catalogued mapping (verified)', async () => {
    // buyFrame carries networkId 56. The six product IDs are
    // VERIFIED-FROM-CAPTURE (docs/evidence/fomo-network-catalog.md), so no
    // provisional diagnostic is emitted.
    const { ingestor, diagnostics } = createHarness();

    await ingestor.ingest({ payload: buyFrame.payload, receivedAt: RECEIVED_AT });

    expect(
      diagnostics
        .snapshot()
        .some((record) => record.code === 'provisional_network_mapping'),
    ).toBe(false);
  });

  it('does not record a provisional diagnostic for an uncatalogued mapping', async () => {
    const { ingestor, diagnostics } = createHarness();

    await ingestor.ingest({
      payload: {
        ...buyFrame.payload,
        id: 'activity-uncatalogued',
        networkId: 999999,
      },
      receivedAt: RECEIVED_AT,
    });

    // 999999 is not in the catalog: getNetworkMapping returns null, so there
    // is no mapping status to diagnose.
    expect(diagnostics.snapshot()).toEqual([]);
  });

  it('increments the unknown-network aggregate only after raw schema validation', async () => {
    const { ingestor, health } = createHarness();

    // Fails the raw schema: never counted as an unknown network.
    await ingestor.ingest({
      payload: { type: 'swap_buy', networkId: 950001 },
      receivedAt: RECEIVED_AT,
    });
    expect(health.snapshot().unknownNetworkAggregates ?? []).toEqual([]);

    // Passes raw schema: counted before any dedup/storage decision, so a
    // duplicate of an unknown-network event counts too. 950001 is NOT in the
    // catalog (900001 now provisionally maps to robinhood), so it is a true
    // unknown network.
    await ingestor.ingest({
      payload: { ...buyFrame.payload, id: 'u1', networkId: 950001 },
      receivedAt: RECEIVED_AT,
    });
    await ingestor.ingest({
      payload: { ...buyFrame.payload, id: 'u1', networkId: 950001 },
      receivedAt: RECEIVED_AT + 1,
    });

    expect(health.snapshot().unknownNetworkAggregates).toEqual([
      { networkId: 950001, count: 2, lastSeenAt: RECEIVED_AT + 1 },
    ]);
  });

  it('does not aggregate catalogued network IDs', async () => {
    const { ingestor, health } = createHarness();

    await ingestor.ingest({ payload: buyFrame.payload, receivedAt: RECEIVED_AT });

    expect(health.snapshot().unknownNetworkAggregates ?? []).toEqual([]);
  });

  it('counts an unknown network before canonical normalization even when normalization fails', async () => {
    const { ingestor, health } = createHarness();

    // The raw schema passes (the network ID is a valid integer) but canonical
    // normalization rejects the invalid receivedAt: the aggregate is counted
    // first, and the failure is attributed to the normalization stage.
    await ingestor.ingest({
      payload: { ...buyFrame.payload, id: 'u1', networkId: 950001 },
      receivedAt: -1,
    });

    expect(health.snapshot().unknownNetworkAggregates?.[0]).toMatchObject({
      networkId: 950001,
      count: 1,
    });
    expect(health.snapshot().rejectionStages).toMatchObject({ normalization: 1 });
    expect(health.snapshot().lastRejectionStage).toBe('normalization');
  });

  it('suppresses the toast for a muted trader but still persists history', async () => {
    const annotation: TraderAnnotationV1 = {
      traderId: 'trader-1',
      muted: true,
      updatedAt: 1,
    };
    const { ingestor, broadcast, events } = createHarness({ annotation });

    // The suppression cache is seeded at worker bootstrap; prime it here.
    await ingestor.warmSuppression();

    const outcome = await ingestor.ingest({
      payload: buyFrame.payload,
      receivedAt: RECEIVED_AT,
    });

    if (outcome.status !== 'inserted') {
      throw new Error('expected an inserted outcome');
    }

    expect(broadcast.messages[0]?.payload.toast).toBe(false);
    expect(events.stored.has('fomo:activity-1')).toBe(true);
  });

  it('suppresses the toast for a muted chain but still persists history', async () => {
    // buyFrame (networkId 56) is VERIFIED-FROM-CAPTURE for bsc, so muting
    // 'bsc' suppresses the toast while the event is still persisted.
    const settings: LocalSettingsV4 = {
      ...DEFAULT_SETTINGS,
      filters: { ...DEFAULT_SETTINGS.filters, mutedChains: ['bsc'] },
    };
    const { ingestor, broadcast, events } = createHarness({ settings });

    await ingestor.warmSuppression();

    const outcome = await ingestor.ingest({
      payload: buyFrame.payload,
      receivedAt: RECEIVED_AT,
    });

    if (outcome.status !== 'inserted') {
      throw new Error('expected an inserted outcome');
    }

    expect(broadcast.messages[0]?.payload.toast).toBe(false);
    expect(events.stored.has('fomo:activity-1')).toBe(true);
  });

  it.each([
    [{ minimumUsdAmount: 2_000 }, 1_250.5, false],
    [{ minimumUsdAmount: 1_000 }, 1_250.5, true],
    [{ minimumUsdAmount: 1_000 }, undefined, false],
  ])(
    'applies the minimumUsdAmount filter %j with amount %p to toast %s',
    async (filters, usdAmount, expectedToast) => {
      const settings: LocalSettingsV4 = {
        ...DEFAULT_SETTINGS,
        filters: { mutedChains: [], ...filters },
      };
      const { ingestor, broadcast } = createHarness({ settings });

      await ingestor.warmSuppression();

      const payload =
        usdAmount === undefined
          ? { ...buyFrame.payload, usdAmount: undefined }
          : { ...buyFrame.payload, usdAmount };

      await ingestor.ingest({ payload, receivedAt: RECEIVED_AT });

      expect(broadcast.messages[0]?.payload.toast).toBe(expectedToast);
    },
  );

  it('toasts by default when no suppression applies', async () => {
    const { ingestor, broadcast } = createHarness();

    await ingestor.ingest({ payload: buyFrame.payload, receivedAt: RECEIVED_AT });

    expect(broadcast.messages[0]?.payload.toast).toBe(true);
  });

  it('broadcasts immediately even when the preference reads reject', async () => {
    const { order, ingestor, broadcast, events } = createHarness({ rejectReads: true });

    const outcome = await ingestor.ingest({
      payload: buyFrame.payload,
      receivedAt: RECEIVED_AT,
    });

    if (outcome.status !== 'inserted') {
      throw new Error('expected an inserted outcome');
    }

    // The broadcast must never be gated on the storage reads: it fires with a
    // safe default toast flag and the reads are refreshed in the background.
    expect(order).toEqual(['insert', 'broadcast', 'fetch']);
    expect(broadcast.messages).toHaveLength(1);
    expect(broadcast.messages[0]?.payload.toast).toBe(true);
    expect(events.stored.has('fomo:activity-1')).toBe(true);

    await outcome.enrichment;
  });

  it('does not delay the broadcast while the preference reads are still in flight', async () => {
    // A preferences fake whose reads never settle must not block ingest: the
    // broadcast and enrichment proceed from the cached suppression decision.
    const order: string[] = [];
    const events = createEventsFake(order);
    const neverSettlingPreferences = {
      getSettings: () => new Promise<LocalSettingsV4>(() => {}),
      listAnnotations: () => new Promise<TraderAnnotationV1[]>(() => {}),
    };
    const source = createSourceFake(order);
    const broadcast = createBroadcastFake(order);
    const ingestor = new ActivityIngestor({
      events,
      preferences: neverSettlingPreferences,
      diagnostics: new DiagnosticRecorder({ now: () => DIAGNOSTIC_AT }),
      rejections: createRejectionCounter(),
      metricSource: source,
      broadcast: broadcast.broadcast,
    });

    const outcome = await ingestor.ingest({
      payload: buyFrame.payload,
      receivedAt: RECEIVED_AT,
    });

    if (outcome.status !== 'inserted') {
      throw new Error('expected an inserted outcome');
    }

    expect(order).toEqual(['insert', 'broadcast', 'fetch']);
    expect(broadcast.messages[0]?.payload.toast).toBe(true);
  });

  it('aborts a hanging enrichment fetch when the timeout elapses', async () => {
    const { order, ingestor, source } = createHarness({ enrichmentTimeoutMs: 25 });
    source.setBehavior('hang-until-abort');

    const outcome = await ingestor.ingest({
      payload: buyFrame.payload,
      receivedAt: RECEIVED_AT,
    });

    if (outcome.status !== 'inserted') {
      throw new Error('expected an inserted outcome');
    }

    // Without a real timeout the enrichment promise would never settle and
    // this await would hang the test.
    await expect(outcome.enrichment).resolves.toBeUndefined();

    expect(source.abortCount()).toBe(1);
    expect(order).toEqual(['insert', 'broadcast', 'fetch']);
  });

  it('warmSuppression seeds the cached decision without any ingest', async () => {
    const annotation: TraderAnnotationV1 = {
      traderId: 'trader-1',
      muted: true,
      updatedAt: 1,
    };
    const { ingestor, broadcast } = createHarness({ annotation });

    await ingestor.warmSuppression();
    await ingestor.ingest({ payload: buyFrame.payload, receivedAt: RECEIVED_AT });

    expect(broadcast.messages[0]?.payload.toast).toBe(false);
  });
});

describe('ActivityIngestor.ingestRecovered', () => {
  const makeRecoveredEvent = (overrides: Partial<TradeEventV1> = {}): TradeEventV1 => ({
    schemaVersion: 1,
    id: 'fomo:recovered-1',
    source: 'fomo',
    traderId: 'trader-1',
    traderHandle: 'alpha',
    chain: 'unknown',
    tokenAddress: '0x0000000000000000000000000000000000000000',
    tokenSymbol: 'TKN',
    action: 'buy',
    occurredAt: RECEIVED_AT - 5_000,
    receivedAt: RECEIVED_AT,
    ...overrides,
  });

  it('persists, broadcasts with toast: true, and enriches a recovered event', async () => {
    const { order, ingestor, events, broadcast, source } = createHarness();
    source.setBehavior(LEADERBOARD_SNAPSHOT);

    const outcome = await ingestor.ingestRecovered(makeRecoveredEvent());

    if (outcome.status !== 'inserted') {
      throw new Error('expected an inserted outcome');
    }

    await outcome.enrichment;

    expect(order).toEqual(['insert', 'broadcast', 'fetch', 'update']);
    expect(broadcast.messages).toHaveLength(1);
    expect(broadcast.messages[0]?.payload.toast).toBe(true);
    expect((broadcast.messages[0]?.payload.event as { id?: string }).id).toBe(
      'fomo:recovered-1',
    );
    expect(events.stored.get('fomo:recovered-1')?.metricSnapshot).toEqual(
      LEADERBOARD_SNAPSHOT,
    );
  });

  it('never consults the suppression cache: a muted trader still toasts', async () => {
    const annotation: TraderAnnotationV1 = {
      traderId: 'trader-1',
      muted: true,
      updatedAt: 1,
    };
    const { ingestor, broadcast } = createHarness({ annotation });

    await ingestor.warmSuppression();
    await ingestor.ingestRecovered(makeRecoveredEvent());

    expect(broadcast.messages[0]?.payload.toast).toBe(true);
  });

  it('reports duplicate without broadcast or enrichment for an already-stored id', async () => {
    const { order, ingestor, broadcast, source } = createHarness();
    source.setBehavior(LEADERBOARD_SNAPSHOT);

    const first = await ingestor.ingestRecovered(makeRecoveredEvent());
    const second = await ingestor.ingestRecovered(makeRecoveredEvent());

    if (first.status !== 'inserted') {
      throw new Error('expected an inserted outcome');
    }

    expect(second).toEqual({
      status: 'duplicate',
      event: expect.objectContaining({ id: 'fomo:recovered-1' }),
    });
    expect(broadcast.messages).toHaveLength(1);
    await first.enrichment;
  });

  it('records the same health path as live events', async () => {
    const { ingestor, health } = createHarness();

    await ingestor.ingestRecovered(makeRecoveredEvent());
    await ingestor.ingestRecovered(makeRecoveredEvent());

    expect(health.snapshot()).toMatchObject({
      accepted: 2,
      persisted: 1,
      broadcasts: 1,
      duplicates: 1,
      lastRejectionCode: 'duplicate',
    });
  });

  it('does not record a provisional-network-mapping diagnostic for verified mappings', async () => {
    // buyFrame-style networkId 56 is verified-from-capture; a recovered event
    // carrying it must not emit a provisional diagnostic.
    const { ingestor, diagnostics } = createHarness();

    await ingestor.ingestRecovered(makeRecoveredEvent({ networkId: 56 }));

    expect(
      diagnostics
        .snapshot()
        .some((record) => record.code === 'provisional_network_mapping'),
    ).toBe(false);
  });

  it('bypasses normalization: the raw-schema rejection counter is never touched', async () => {
    // ingestRecovered takes an already-normalized TradeEventV1, so the
    // raw-schema gate and the rejection counter are bypassed entirely.
    const { ingestor, events, rejections } = createHarness();

    const outcome = await ingestor.ingestRecovered(makeRecoveredEvent());

    expect(outcome.status).toBe('inserted');
    expect(rejections.value()).toBe(0);
    expect(events.stored.size).toBe(1);
  });

  it('throws on a broadcast failure after recording the rejection, exactly like live ingest', async () => {
    const order: string[] = [];
    const events = createEventsFake(order);
    const preferences = createPreferencesFake();
    const source = createSourceFake(order);
    const diagnostics = new DiagnosticRecorder({ now: () => DIAGNOSTIC_AT });
    const health = new PipelineHealthState(() => RECEIVED_AT);
    const ingestor = new ActivityIngestor({
      events,
      preferences,
      diagnostics,
      rejections: createRejectionCounter(),
      metricSource: source,
      broadcast: async (): Promise<void> => {
        order.push('broadcast');
        throw new Error('overlay send failed');
      },
      health,
    });

    await expect(
      ingestor.ingestRecovered(makeRecoveredEvent()),
    ).rejects.toThrow('overlay send failed');

    expect(order).toEqual(['insert', 'broadcast']);
    expect(health.snapshot()).toMatchObject({
      persisted: 1,
      broadcastFailures: 1,
      lastRejectionCode: 'broadcast_failed',
    });
  });
});

describe('shouldToast', () => {
  const makeEvent = (overrides: {
    chain?: ChainKey;
    usdAmount?: number;
    traderId?: string;
  } = {}): TradeEventV1 => ({
    schemaVersion: 1,
    id: 'fomo:test',
    source: 'fomo',
    traderId: overrides.traderId ?? 'trader-1',
    traderHandle: 'alpha',
    chain: overrides.chain ?? 'solana',
    tokenAddress: 'token-1',
    tokenSymbol: 'TKN',
    action: 'buy',
    occurredAt: 1_000,
    receivedAt: 2_000,
    ...(overrides.usdAmount !== undefined ? { usdAmount: overrides.usdAmount } : {}),
  });

  it('toasts when nothing suppresses', () => {
    expect(shouldToast(makeEvent({ usdAmount: 500 }), DEFAULT_SETTINGS, undefined)).toBe(
      true,
    );
  });

  it('suppresses for a muted annotation', () => {
    const annotation: TraderAnnotationV1 = {
      traderId: 'trader-1',
      muted: true,
      updatedAt: 1,
    };

    expect(shouldToast(makeEvent(), DEFAULT_SETTINGS, annotation)).toBe(false);
  });

  it('does not suppress for an unmuted annotation', () => {
    const annotation: TraderAnnotationV1 = { traderId: 'trader-1', updatedAt: 1 };

    expect(shouldToast(makeEvent(), DEFAULT_SETTINGS, annotation)).toBe(true);
  });

  it('suppresses for a muted chain', () => {
    const settings: LocalSettingsV4 = {
      ...DEFAULT_SETTINGS,
      filters: { mutedChains: ['solana'] },
    };

    expect(shouldToast(makeEvent({ chain: 'solana' }), settings, undefined)).toBe(false);
    expect(shouldToast(makeEvent({ chain: 'base' }), settings, undefined)).toBe(true);
  });

  it('suppresses below the configured minimum amount', () => {
    const settings: LocalSettingsV4 = {
      ...DEFAULT_SETTINGS,
      filters: { mutedChains: [], minimumUsdAmount: 1_000 },
    };

    expect(shouldToast(makeEvent({ usdAmount: 999 }), settings, undefined)).toBe(false);
    expect(shouldToast(makeEvent({ usdAmount: 1_000 }), settings, undefined)).toBe(true);
  });

  it('suppresses when the amount is unknown and a minimum is configured', () => {
    const settings: LocalSettingsV4 = {
      ...DEFAULT_SETTINGS,
      filters: { mutedChains: [], minimumUsdAmount: 1_000 },
    };

    expect(shouldToast(makeEvent(), settings, undefined)).toBe(false);
  });
});
