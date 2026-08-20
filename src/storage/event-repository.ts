import Dexie, {
  type Collection,
} from 'dexie';

import type { ChainKey, TradeEventV1 } from '../domain/activity';

import type { FomoFeedDatabase } from './database';

export interface EventPageQuery {
  limit: number;
  beforeOccurredAt?: number;
  traderId?: string;
  chain?: ChainKey;
  tokenAddress?: string;
  unreadOnly?: boolean;
}

interface EventTable {
  add(event: TradeEventV1): Promise<unknown>;
  count(): Promise<number>;
  get(id: string): Promise<TradeEventV1 | undefined>;
  orderBy(index: string): unknown;
  update(id: string, changes: Partial<TradeEventV1>): Promise<number>;
  where(index: string): {
    aboveOrEqual(value: number): { count(): Promise<number> };
    below(value: number): unknown;
    between(
      lower: [string, typeof Dexie.minKey],
      upper: [string, number | typeof Dexie.maxKey],
      includeLower: boolean,
      includeUpper: boolean,
    ): unknown;
  };
}

const DEFAULT_BATCH_SIZE = 50;
const MAX_PAGE_SIZE = 100;

const asEventCollection = (value: unknown): Collection<TradeEventV1, string, TradeEventV1> =>
  value as Collection<TradeEventV1, string, TradeEventV1>;

const isFiniteNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isConstraintError = (error: unknown) =>
  error instanceof Dexie.DexieError && error.name === Dexie.errnames.Constraint;

const validateLimit = (limit: number) => {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new TypeError('limit must be a positive integer');
  }

  return Math.min(limit, MAX_PAGE_SIZE);
};

const validateCursor = (beforeOccurredAt: number | undefined) => {
  if (
    beforeOccurredAt !== undefined &&
    !isFiniteNonNegativeInteger(beforeOccurredAt)
  ) {
    throw new TypeError('beforeOccurredAt must be a finite non-negative integer');
  }
};

const validateReadAt = (readAt: number) => {
  if (!isFiniteNonNegativeInteger(readAt)) {
    throw new TypeError('readAt must be a finite non-negative integer');
  }
};

const applyFilters = (
  candidates: TradeEventV1[],
  query: EventPageQuery,
): TradeEventV1[] =>
  candidates.filter((event) => {
    if (query.unreadOnly && event.readAt !== undefined) {
      return false;
    }

    if (query.traderId && event.traderId !== query.traderId) {
      return false;
    }

    if (query.chain && event.chain !== query.chain) {
      return false;
    }

    if (query.tokenAddress && event.tokenAddress !== query.tokenAddress) {
      return false;
    }

    return true;
  });

export class EventRepository {
  constructor(
    private readonly database: Pick<FomoFeedDatabase, 'events'>,
    private readonly table: EventTable,
  ) {}

  async insert(event: TradeEventV1): Promise<boolean> {
    try {
      await this.table.add(event);
      return true;
    } catch (error) {
      if (isConstraintError(error)) {
        return false;
      }

      throw error;
    }
  }

  get(id: string): Promise<TradeEventV1 | undefined> {
    return this.table.get(id);
  }

  async markRead(id: string, at: number): Promise<boolean> {
    validateReadAt(at);

    const updated = await this.table.update(id, { readAt: at });

    return updated === 1;
  }

  async page(query: EventPageQuery): Promise<TradeEventV1[]> {
    const limit = validateLimit(query.limit);
    validateCursor(query.beforeOccurredAt);

    const batchSize = Math.max(DEFAULT_BATCH_SIZE, limit * 2);
    const collection = this.selectIndexedCollection(query, query.beforeOccurredAt);
    const results: TradeEventV1[] = [];
    let offset = 0;

    while (results.length < limit) {
      const candidates = await this.fetchBatch(collection, offset, batchSize);

      if (candidates.length === 0) {
        break;
      }

      const filtered = applyFilters(candidates, query);

      for (const event of filtered) {
        results.push(event);

        if (results.length === limit) {
          break;
        }
      }

      if (candidates.length < batchSize) {
        break;
      }

      offset += candidates.length;
    }

    return results;
  }

  async unreadCount(): Promise<number> {
    const [totalCount, readCount] = await Promise.all([
      this.table.count(),
      this.database.events.where('readAt').aboveOrEqual(0).count(),
    ]);

    return totalCount - readCount;
  }

  private async fetchBatch(
    collection: Collection<TradeEventV1, string, TradeEventV1>,
    offset: number,
    batchSize: number,
  ): Promise<TradeEventV1[]> {
    return collection.clone().offset(offset).limit(batchSize).toArray();
  }

  private selectIndexedCollection(
    query: EventPageQuery,
    beforeOccurredAt: number | undefined,
  ): Collection<TradeEventV1, string, TradeEventV1> {
    if (query.traderId) {
      return asEventCollection(
        this.table.where('[traderId+occurredAt]').between(
          [query.traderId, Dexie.minKey],
          [
            query.traderId,
            beforeOccurredAt === undefined ? Dexie.maxKey : beforeOccurredAt - 1,
          ],
          true,
          true,
        ),
      ).reverse();
    }

    if (query.chain) {
      return asEventCollection(
        this.table.where('[chain+occurredAt]').between(
          [query.chain, Dexie.minKey],
          [query.chain, beforeOccurredAt === undefined ? Dexie.maxKey : beforeOccurredAt - 1],
          true,
          true,
        ),
      ).reverse();
    }

    if (query.tokenAddress) {
      return asEventCollection(
        this.table.where('[tokenAddress+occurredAt]').between(
          [query.tokenAddress, Dexie.minKey],
          [
            query.tokenAddress,
            beforeOccurredAt === undefined ? Dexie.maxKey : beforeOccurredAt - 1,
          ],
          true,
          true,
        ),
      ).reverse();
    }

    if (beforeOccurredAt === undefined) {
      return asEventCollection(this.table.orderBy('occurredAt')).reverse();
    }

    return asEventCollection(
      this.table.where('occurredAt').below(beforeOccurredAt),
    ).reverse();
  }
}
