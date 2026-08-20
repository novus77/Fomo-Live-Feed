import type { MetricSnapshotV1 } from '../domain/activity';

export interface MetricCacheRecord extends MetricSnapshotV1 {
  traderId: string;
  expiresAt: number;
}

const METRIC_NUMBER_KEYS = [
  'pnl7d',
  'winRate7d',
  'followers',
  'tradeCount',
  'averageHoldSeconds',
] as const satisfies ReadonlyArray<keyof MetricCacheRecord>;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const isFiniteNonNegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0;

const assertFiniteMetricRecord = (record: MetricCacheRecord) => {
  if (
    !isFiniteNonNegativeInteger(record.fetchedAt) ||
    !isFiniteNonNegativeInteger(record.expiresAt)
  ) {
    throw new TypeError('fetchedAt and expiresAt must be finite non-negative integers');
  }

  if (record.expiresAt <= record.fetchedAt) {
    throw new TypeError('expiresAt must be greater than fetchedAt');
  }

  for (const key of METRIC_NUMBER_KEYS) {
    const value = record[key];

    if (value !== undefined && !isFiniteNumber(value)) {
      throw new TypeError(`metric record field ${key} must be finite when provided`);
    }
  }
};

export class MetricRepository {
  constructor(private readonly table: {
    get(traderId: string): Promise<MetricCacheRecord | undefined>;
    put(record: MetricCacheRecord): Promise<unknown>;
  }) {}

  async getFresh(traderId: string, now: number): Promise<MetricCacheRecord | undefined> {
    if (!isFiniteNumber(now)) {
      throw new TypeError('now must be a finite number');
    }

    const record = await this.table.get(traderId);

    if (!record || record.expiresAt <= now) {
      return undefined;
    }

    return record;
  }

  async put(record: MetricCacheRecord): Promise<void> {
    assertFiniteMetricRecord(record);
    await this.table.put(record);
  }
}
