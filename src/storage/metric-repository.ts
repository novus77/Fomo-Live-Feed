import type { MetricSnapshotV1 } from '../domain/activity';

export interface MetricCacheRecord extends MetricSnapshotV1 {
  traderId: string;
  expiresAt: number;
}

const METRIC_NUMBER_KEYS = [
  'fetchedAt',
  'expiresAt',
  'pnl7d',
  'winRate7d',
  'followers',
  'tradeCount',
  'averageHoldSeconds',
] as const satisfies ReadonlyArray<keyof MetricCacheRecord>;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const assertFiniteMetricRecord = (record: MetricCacheRecord) => {
  for (const key of METRIC_NUMBER_KEYS) {
    const value = record[key];

    if (value !== undefined && !isFiniteNumber(value)) {
      if (key === 'fetchedAt' || key === 'expiresAt') {
        throw new TypeError('metric record timestamps must be finite numbers');
      }

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
