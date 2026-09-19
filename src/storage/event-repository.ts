import Dexie, {
  type Collection,
} from 'dexie';

import type { ChainKey, TradeEventV1 } from '../domain/activity';
import { validateContractAddress } from '../navigation/contract-address';
import type { ActivitySource } from '../domain/activity';

export interface EventPageQuery {
  limit: number;
  beforeOccurredAt?: number;
  beforeId?: string;
  traderId?: string;
  chain?: ChainKey;
  tokenAddress?: string;
  unreadOnly?: boolean;
}

/** networkId -> chain reclassification mapping (only verified mappings). */
export type UnknownChainMappings = ReadonlyMap<number, ChainKey>;

interface EventTable {
  add(event: TradeEventV1): Promise<unknown>;
  count(): Promise<number>;
  get(id: string): Promise<TradeEventV1 | undefined>;
  orderBy(index: string): unknown;
  toArray(): Promise<TradeEventV1[]>;
  update(id: string, changes: Partial<TradeEventV1>): Promise<number>;
  where(index: string): {
    aboveOrEqual(value: number): { count(): Promise<number> };
    belowOrEqual(value: number): unknown;
    below(value: number): unknown;
    between(
      lower: [string, typeof Dexie.minKey],
      upper: [string, number | typeof Dexie.maxKey],
      includeLower: boolean,
      includeUpper: boolean,
    ): unknown;
  };
}

interface EventDatabase {
  events: EventTable;
  eventAliases?: EventAliasTable;
  transaction?: unknown;
}

interface EventAliasTable {
  add(record: EventAliasRecord): Promise<unknown>;
  get(aliasKey: string): Promise<EventAliasRecord | undefined>;
}

export interface EventAliasRecord {
  aliasKey: string;
  canonicalEventId: string;
}

export type EventPersistResult =
  | { status: 'inserted'; event: TradeEventV1 }
  | { status: 'duplicate'; event: TradeEventV1 };

const MAX_PAGE_SIZE = 100;

const asEventCollection = (value: unknown): Collection<TradeEventV1, string, TradeEventV1> =>
  value as Collection<TradeEventV1, string, TradeEventV1>;

const isFiniteNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const isConstraintError = (error: unknown) =>
  error instanceof Dexie.DexieError && error.name === Dexie.errnames.Constraint;

const sourceScopedAliasKey = (
  source: ActivitySource,
  networkId: number | undefined,
  kind: 'event' | 'trade',
  value: string,
): string => JSON.stringify([
  'v1',
  source,
  networkId === undefined ? 'unknown-network' : networkId,
  kind,
  value,
]);

/**
 * Raw activity identifiers are only meaningful inside their originating
 * platform and network. Fomo and Pump can both emit a value such as `42`, so
 * their aliases must never occupy the same identity namespace.
 */
export function createEventAliasRecords(event: TradeEventV1): EventAliasRecord[] {
  const aliases: EventAliasRecord[] = [];
  const add = (kind: 'event' | 'trade', value: string | undefined) => {
    if (value === undefined || value.trim().length === 0) return;
    aliases.push({
      aliasKey: sourceScopedAliasKey(event.source, event.networkId, kind, value),
      canonicalEventId: event.id,
    });
  };

  add('event', event.sourceEventId);
  add('trade', event.sourceTradeId);
  return aliases;
}

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

const validateBeforeId = (
  beforeOccurredAt: number | undefined,
  beforeId: string | undefined,
) => {
  if (beforeId !== undefined && beforeOccurredAt === undefined) {
    throw new TypeError('beforeId requires beforeOccurredAt');
  }
};

const validateReadAt = (readAt: number) => {
  if (!isFiniteNonNegativeInteger(readAt)) {
    throw new TypeError('readAt must be a finite non-negative integer');
  }
};

const matchesFilters = (
  event: TradeEventV1,
  query: EventPageQuery,
): boolean => {
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
};

const isBeforeCompositeCursor = (
  event: TradeEventV1,
  beforeOccurredAt: number,
  beforeId: string,
) =>
  event.occurredAt < beforeOccurredAt ||
  (event.occurredAt === beforeOccurredAt && event.id < beforeId);

/**
 * Scans the events table and reclassifies stored rows whose chain is
 * 'unknown' into their resolved chain. A row is reclassified ONLY when ALL
 * of the following hold:
 *
 * 1. its chain is exactly 'unknown' (rows already carrying a chain are
 *    never touched);
 * 2. its networkId is a verified numeric value — a finite, non-negative
 *    integer (missing, fractional, negative, or non-numeric IDs are left
 *    alone);
 * 3. the networkId is present in the caller-supplied `mappings`;
 * 4. its tokenAddress passes chain-specific validation for the resolved
 *    chain (validateContractAddress), so a reclassified row is guaranteed
 *    to render and be copyable on its new chain.
 *
 * The caller must pass ONLY verified mappings (status
 * 'verified-from-capture' in src/fomo/network-map.ts): provisional catalog
 * entries must never reclassify historical rows, because no ID has been
 * confirmed against a real Fomo capture yet.
 *
 * The operation is idempotent: a second run re-examines the same rows but
 * updates nothing (their chain is no longer 'unknown'), so it is safe to
 * invoke at every database upgrade.
 *
 * @returns { scanned, updated } — `scanned` counts every row examined,
 *   `updated` counts rows whose chain was actually changed.
 */
export async function reclassifyUnknownChainEvents(
  events: Pick<EventTable, 'toArray' | 'update'>,
  mappings: UnknownChainMappings,
): Promise<{ scanned: number; updated: number }> {
  let scanned = 0;
  let updated = 0;

  const rows = await events.toArray();

  for (const event of rows) {
    scanned += 1;

    if (event.source !== 'fomo' || event.chain !== 'unknown') {
      continue;
    }

    if (
      event.networkId === undefined ||
      !Number.isInteger(event.networkId) ||
      event.networkId < 0
    ) {
      continue;
    }

    const resolvedChain = mappings.get(event.networkId);

    if (resolvedChain === undefined) {
      continue;
    }

    const validation = validateContractAddress(
      resolvedChain,
      event.tokenAddress,
    );

    if (!validation.ok) {
      continue;
    }

    const result = await events.update(event.id, { chain: resolvedChain });

    if (result === 1) {
      updated += 1;
    }
  }

  return { scanned, updated };
}

export class EventRepository {
  constructor(private readonly database: EventDatabase) {}

  async insert(event: TradeEventV1): Promise<boolean> {
    try {
      await this.database.events.add(event);
      return true;
    } catch (error) {
      if (isConstraintError(error)) {
        return false;
      }

      throw error;
    }
  }

  /**
   * Atomically persists an event with its stable, source-scoped aliases.
   *
   * We deliberately do not fuzzy-merge separate platform events. An alias is
   * considered a duplicate only when it proves the same source and network
   * identity; otherwise both rows remain visible rather than losing activity.
   */
  async persist(event: TradeEventV1): Promise<EventPersistResult> {
    const aliases = createEventAliasRecords(event);
    const aliasesTable = this.database.eventAliases;
    const transaction = this.database.transaction as ((
      mode: 'rw',
      events: EventTable,
      aliases: EventAliasTable,
      scope: () => Promise<EventPersistResult>,
    ) => Promise<EventPersistResult>) | undefined;

    if (aliasesTable === undefined || transaction === undefined) {
      throw new Error('Event alias storage is unavailable');
    }

    const persistInTransaction = async (): Promise<EventPersistResult> => {
      for (const alias of aliases) {
        const match = await aliasesTable.get(alias.aliasKey);
        if (match === undefined) continue;
        const existing = await this.database.events.get(match.canonicalEventId);
        if (existing !== undefined) return { status: 'duplicate', event: existing };
      }

      const sameId = await this.database.events.get(event.id);
      if (sameId !== undefined) return { status: 'duplicate', event: sameId };

      await this.database.events.add(event);
      for (const alias of aliases) {
        await aliasesTable.add(alias);
      }
      return { status: 'inserted', event };
    };

    try {
      return await transaction.call(
        this.database,
        'rw',
        this.database.events,
        aliasesTable,
        persistInTransaction,
      ) as EventPersistResult;
    } catch (error) {
      // A concurrent transaction may have committed the alias after this
      // transaction read it. Resolve that exact alias after rollback instead
      // of turning a replay into an ingest failure.
      if (!isConstraintError(error)) throw error;
      for (const alias of aliases) {
        const match = await aliasesTable.get(alias.aliasKey);
        if (match === undefined) continue;
        const existing = await this.database.events.get(match.canonicalEventId);
        if (existing !== undefined) return { status: 'duplicate', event: existing };
      }
      const sameId = await this.database.events.get(event.id);
      if (sameId !== undefined) return { status: 'duplicate', event: sameId };
      throw error;
    }
  }

  get(id: string): Promise<TradeEventV1 | undefined> {
    return this.database.events.get(id);
  }

  async markRead(id: string, at: number): Promise<boolean> {
    validateReadAt(at);

    const updated = await this.database.events.update(id, { readAt: at });

    return updated === 1;
  }

  async page(query: EventPageQuery): Promise<TradeEventV1[]> {
    const limit = validateLimit(query.limit);
    validateCursor(query.beforeOccurredAt);
    validateBeforeId(query.beforeOccurredAt, query.beforeId);

    const collection = this.selectIndexedCollection(query);
    const results: TradeEventV1[] = [];

    await collection
      .until(() => results.length >= limit)
      .each((event) => {
        if (
          query.beforeOccurredAt !== undefined &&
          query.beforeId !== undefined &&
          !isBeforeCompositeCursor(event, query.beforeOccurredAt, query.beforeId)
        ) {
          return;
        }

        if (!matchesFilters(event, query)) {
          return;
        }

        results.push(event);
      });

    return results;
  }

  async unreadCount(): Promise<number> {
    const [totalCount, readCount] = await Promise.all([
      this.database.events.count(),
      this.database.events.where('readAt').aboveOrEqual(0).count(),
    ]);

    return totalCount - readCount;
  }

  /**
   * Reclassifies stored 'unknown'-chain rows whose networkId is present in
   * `mappings` and whose address validates for the resolved chain. Only
   * verified mappings may be passed (see reclassifyUnknownChainEvents).
   * Idempotent: safe to call repeatedly and at every database upgrade.
   */
  reclassifyUnknownEvents(
    mappings: UnknownChainMappings,
  ): Promise<{ scanned: number; updated: number }> {
    return reclassifyUnknownChainEvents(this.database.events, mappings);
  }

  private selectIndexedCollection(
    query: EventPageQuery,
  ): Collection<TradeEventV1, string, TradeEventV1> {
    if (query.traderId) {
      return asEventCollection(
        this.database.events.where('[traderId+occurredAt]').between(
          [query.traderId, Dexie.minKey],
          [
            query.traderId,
            query.beforeOccurredAt === undefined ? Dexie.maxKey : query.beforeOccurredAt,
          ],
          true,
          query.beforeId !== undefined || query.beforeOccurredAt === undefined,
        ),
      ).reverse();
    }

    if (query.chain) {
      return asEventCollection(
        this.database.events.where('[chain+occurredAt]').between(
          [query.chain, Dexie.minKey],
          [query.chain, query.beforeOccurredAt === undefined ? Dexie.maxKey : query.beforeOccurredAt],
          true,
          query.beforeId !== undefined || query.beforeOccurredAt === undefined,
        ),
      ).reverse();
    }

    if (query.tokenAddress) {
      return asEventCollection(
        this.database.events.where('[tokenAddress+occurredAt]').between(
          [query.tokenAddress, Dexie.minKey],
          [
            query.tokenAddress,
            query.beforeOccurredAt === undefined ? Dexie.maxKey : query.beforeOccurredAt,
          ],
          true,
          query.beforeId !== undefined || query.beforeOccurredAt === undefined,
        ),
      ).reverse();
    }

    if (query.beforeOccurredAt === undefined) {
      return asEventCollection(this.database.events.orderBy('occurredAt')).reverse();
    }

    if (query.beforeId !== undefined) {
      return asEventCollection(
        this.database.events.where('occurredAt').belowOrEqual(query.beforeOccurredAt),
      ).reverse();
    }

    return asEventCollection(this.database.events.where('occurredAt').below(query.beforeOccurredAt)).reverse();
  }
}
