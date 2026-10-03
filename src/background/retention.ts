import type { FomoFeedDatabase } from '../storage/database';
import type { EventAliasRecord } from '../storage/event-repository';

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_EVENTS = 20_000;
const DEFAULT_BATCH_SIZE = 500;

export interface RetentionOptions {
  now: number;
  maxAgeMs?: number;
  maxEvents?: number;
  batchSize?: number;
}

export interface RetentionResult {
  deletedByAge: number;
  deletedByCount: number;
  totalDeleted: number;
}

const validateFiniteNumber = (value: number, name: string) => {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
};

const validatePositiveInteger = (value: number, name: string) => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive integer`);
  }
};

const validateNonNegativeInteger = (value: number, name: string) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative integer`);
  }
};

export const runRetention = async (
  database: Pick<FomoFeedDatabase, 'events'>,
  options: RetentionOptions,
): Promise<RetentionResult> => {
  validateFiniteNumber(options.now, 'now');

  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const maxEvents = options.maxEvents ?? DEFAULT_MAX_EVENTS;
  const requestedBatchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  validateNonNegativeInteger(maxAgeMs, 'maxAgeMs');
  validatePositiveInteger(maxEvents, 'maxEvents');
  validatePositiveInteger(requestedBatchSize, 'batchSize');

  const batchSize = Math.min(requestedBatchSize, DEFAULT_BATCH_SIZE);
  const aliases = database.events.db.table<EventAliasRecord, string>('eventAliases');
  const deleteEvents = async (ids: string[]): Promise<void> => {
    await database.events.db.transaction('rw', database.events, aliases, async () => {
      await aliases.where('canonicalEventId').anyOf(ids).delete();
      await database.events.bulkDelete(ids);
    });
  };

  const cutoff = options.now - maxAgeMs;
  const expiredIds = await database.events
    .where('occurredAt')
    .below(cutoff)
    .limit(batchSize)
    .primaryKeys();
  const deletedByAge = expiredIds.length;

  if (deletedByAge > 0) {
    await deleteEvents(expiredIds);
  }

  const remainingBudget = batchSize - deletedByAge;
  let deletedByCount = 0;

  if (remainingBudget > 0) {
    const totalCount = await database.events.count();
    const overflow = totalCount - maxEvents;

    if (overflow > 0) {
      const idsToDelete = await database.events
        .orderBy('occurredAt')
        .limit(Math.min(overflow, remainingBudget))
        .primaryKeys();

      deletedByCount = idsToDelete.length;

      if (deletedByCount > 0) {
        await deleteEvents(idsToDelete);
      }
    }
  }

  return {
    deletedByAge,
    deletedByCount,
    totalDeleted: deletedByAge + deletedByCount,
  };
};
