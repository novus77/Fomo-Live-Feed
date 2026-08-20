import Dexie, { type EntityTable } from 'dexie';

import type { TradeEventV1 } from '../domain/activity';

import type { MetricCacheRecord } from './metric-repository';

export class FomoFeedDatabase extends Dexie {
  events!: EntityTable<TradeEventV1, 'id'>;
  metrics!: EntityTable<MetricCacheRecord, 'traderId'>;

  constructor(name = 'fomo-live-feed') {
    super(name);

    this.version(1).stores({
      events:
        'id, occurredAt, [traderId+occurredAt], [chain+occurredAt], [tokenAddress+occurredAt], readAt',
      metrics: 'traderId, expiresAt',
    });
  }
}
