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
  bulkDelete(ids: readonly string[]): Promise<unknown>;
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

const compareEventsDescending = (left: TradeEventV1, right: TradeEventV1) => {
  if (left.occurredAt !== right.occurredAt) {
    return right.occurredAt - left.occurredAt;
  }

  return right.id.localeCompare(left.id);
};

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
    const results: TradeEventV1[] = [];
    let cursor = query.beforeOccurredAt;

    while (results.length < limit) {
      const candidates = await this.fetchBatch(query, cursor, batchSize);

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

      const oldestCandidate = candidates[candidates.length - 1];

      if (!oldestCandidate) {
        break;
      }

      // Cursor semantics are timestamp-only: advancing skips any remaining ties
      // at the boundary because the schema intentionally does not add [occurredAt+id].
      cursor = oldestCandidate.occurredAt;
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

  async deleteByIds(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }

    await this.table.bulkDelete([...ids]);
  }

  private async fetchBatch(
    query: EventPageQuery,
    beforeOccurredAt: number | undefined,
    batchSize: number,
  ): Promise<TradeEventV1[]> {
    const collection = this.selectIndexedCollection(query, beforeOccurredAt);
    const candidates = await collection.limit(batchSize).toArray();

    return candidates.sort(compareEventsDescending);
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
