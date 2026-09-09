export interface PumpCatchUpCandidate {
  key: string;
  occurredAt: number;
}

export type PumpCatchUpResult =
  | { status: 'continue'; cursor: string }
  | { status: 'yield'; cursor: string }
  | { status: 'complete' }
  | {
      status: 'possible-gap';
      reason: 'endpoint-ended' | 'cursor-loop' | 'event-limit' | 'age-limit';
    };

export interface PumpCatchUpCollectorOptions {
  watermark: string;
  startedAt: number;
  maximumEvents?: number;
  maximumAgeMs?: number;
  pagesPerBatch?: number;
}

export class PumpCatchUpCollector<T extends PumpCatchUpCandidate = PumpCatchUpCandidate> {
  private readonly buffered = new Map<string, T>();
  private readonly visitedCursors = new Set<string>();
  private readonly maximumEvents: number;
  private readonly oldestAllowedAt: number;
  private readonly pagesPerBatch: number;
  private examined = 0;
  private pagesInBatch = 0;

  constructor(private readonly options: PumpCatchUpCollectorOptions) {
    if (options.watermark.length === 0) {
      throw new TypeError('watermark must be non-empty');
    }

    this.maximumEvents = options.maximumEvents ?? 1_000;
    this.oldestAllowedAt = options.startedAt - (options.maximumAgeMs ?? 24 * 60 * 60 * 1_000);
    this.pagesPerBatch = options.pagesPerBatch ?? 5;
  }

  acceptPage(items: readonly T[], nextCursor?: string): PumpCatchUpResult {
    this.pagesInBatch += 1;

    for (const item of items) {
      if (item.key === this.options.watermark) {
        return { status: 'complete' };
      }

      if (item.occurredAt < this.oldestAllowedAt) {
        return { status: 'possible-gap', reason: 'age-limit' };
      }

      if (this.examined >= this.maximumEvents) {
        return { status: 'possible-gap', reason: 'event-limit' };
      }

      this.examined += 1;
      if (!this.buffered.has(item.key)) {
        this.buffered.set(item.key, item);
      }
    }

    if (nextCursor === undefined) {
      return { status: 'possible-gap', reason: 'endpoint-ended' };
    }

    if (this.visitedCursors.has(nextCursor)) {
      return { status: 'possible-gap', reason: 'cursor-loop' };
    }

    this.visitedCursors.add(nextCursor);

    if (this.pagesInBatch >= this.pagesPerBatch) {
      this.pagesInBatch = 0;
      return { status: 'yield', cursor: nextCursor };
    }

    return { status: 'continue', cursor: nextCursor };
  }

  drainAscending(): T[] {
    return [...this.buffered.values()].sort(
      (left, right) => left.occurredAt - right.occurredAt || left.key.localeCompare(right.key),
    );
  }
}
