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
    // predicates). Because every catalog entry is currently
    // provisional-unverified (docs/evidence/fomo-network-catalog.md), the
    // verified subset below is EMPTY and this upgrade is a structural no-op
    // today; it becomes active when an entry is promoted to
    // 'verified-from-capture' and a later version bump lands. The operation
    // is idempotent, so re-running it across upgrades is safe.
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
