import Dexie, { type EntityTable } from 'dexie';

import type { TradeEventV1 } from '../domain/activity';
import { NETWORK_CATALOG } from '../fomo/network-map';
import { reclassifyUnknownChainEvents } from './event-repository';

import type { MetricCacheRecord } from './metric-repository';

const EVENTS_SCHEMA =
  'id, occurredAt, [traderId+occurredAt], [chain+occurredAt], [tokenAddress+occurredAt], readAt';
const METRICS_SCHEMA = 'traderId, expiresAt';

export class FomoFeedDatabase extends Dexie {
  events!: EntityTable<TradeEventV1, 'id'>;
  metrics!: EntityTable<MetricCacheRecord, 'traderId'>;

  constructor(name = 'fomo-live-feed') {
    super(name);

    this.version(1).stores({
      events: EVENTS_SCHEMA,
      metrics: METRICS_SCHEMA,
    });

    // Version 2 (Task 3): unknown-chain reclassification migration.
    //
    // Rows stored as chain 'unknown' with a networkId that has since been
    // VERIFIED against a real authenticated Fomo capture are reclassified to
    // their resolved chain (see reclassifyUnknownChainEvents for the exact
    // predicates). The six product entries are now verified-from-capture
    // (docs/evidence/fomo-network-catalog.md), so this upgrade becomes active
    // for stored unknown rows that match those IDs. The operation is
    // idempotent, so re-running it across upgrades is safe.
    this.version(2)
      .stores({
        events: EVENTS_SCHEMA,
        metrics: METRICS_SCHEMA,
      })
      .upgrade(async () => {
        const verifiedMappings = new Map(
          NETWORK_CATALOG.filter(
            (entry) => entry.status === 'verified-from-capture',
          ).map((entry) => [entry.networkId, entry.chain] as const),
        );

        await reclassifyUnknownChainEvents(this.events, verifiedMappings);
      });
  }
}
