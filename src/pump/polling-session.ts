import { PumpCatchUpCollector, type PumpCatchUpCandidate } from './catch-up';
import type { PumpPageParseResult, RawPumpTrade } from './raw-schema';
import { PumpRecentKeys, pumpTransactionKey } from './watermark';

interface BufferedPumpTrade extends PumpCatchUpCandidate {
  raw: RawPumpTrade;
}

export interface PumpPollingSessionSeed {
  watermark?: string;
  recentKeys?: readonly string[];
}

export type PumpPollingResult =
  | { status: 'initial' }
  | { status: 'catching-up'; cursor: string }
  | { status: 'events'; delivery: 'live' | 'recovered'; items: RawPumpTrade[] }
  | { status: 'possible-gap'; items: RawPumpTrade[] };

export class PumpPollingSession {
  private watermark: string | undefined;
  private initialized: boolean;
  private readonly recentKeys: PumpRecentKeys;
  private catchUp: PumpCatchUpCollector<BufferedPumpTrade> | undefined;
  private pendingNewestKey: string | undefined;

  constructor(private readonly options: { startedAt: number; seed?: PumpPollingSessionSeed }) {
    this.watermark = options.seed?.watermark;
    this.initialized = options.seed !== undefined;
    this.recentKeys = new PumpRecentKeys(options.seed?.recentKeys);
  }

  snapshot(): { watermark?: string; recentKeys: string[] } {
    return {
      ...(this.watermark !== undefined ? { watermark: this.watermark } : {}),
      recentKeys: this.recentKeys.values(),
    };
  }

  acceptNewestPage(page: PumpPageParseResult): PumpPollingResult {
    const candidates = page.accepted.map(toCandidate);

    if (!this.initialized) {
      for (const candidate of candidates) this.recentKeys.add(candidate.key);
      this.watermark = candidates[0]?.key;
      this.initialized = true;
      return { status: 'initial' };
    }

    if (this.watermark === undefined) {
      const unseen = candidates.filter((candidate) => !this.recentKeys.has(candidate.key));
      this.acceptAsCurrent(candidates);
      return {
        status: 'events',
        delivery: 'live',
        items: oldestFirst(unseen).map((candidate) => candidate.raw),
      };
    }

    const watermarkIndex = candidates.findIndex((candidate) => candidate.key === this.watermark);
    if (watermarkIndex !== -1) {
      const unseen = candidates.slice(0, watermarkIndex).filter(
        (candidate) => !this.recentKeys.has(candidate.key),
      );
      this.acceptAsCurrent(candidates);
      return {
        status: 'events',
        delivery: 'live',
        items: oldestFirst(unseen).map((candidate) => candidate.raw),
      };
    }

    this.pendingNewestKey = candidates[0]?.key;
    this.catchUp = new PumpCatchUpCollector<BufferedPumpTrade>({
      watermark: this.watermark,
      startedAt: this.options.startedAt,
    });
    return this.consumeCatchUpPage(candidates, page.nextCursor);
  }

  acceptCatchUpPage(page: PumpPageParseResult): PumpPollingResult {
    if (this.catchUp === undefined) {
      throw new Error('Pump catch-up is not active');
    }
    return this.consumeCatchUpPage(page.accepted.map(toCandidate), page.nextCursor);
  }

  private consumeCatchUpPage(
    candidates: BufferedPumpTrade[],
    nextCursor?: string,
  ): PumpPollingResult {
    const collector = this.catchUp;
    if (collector === undefined) throw new Error('Pump catch-up is not active');
    const outcome = collector.acceptPage(candidates, nextCursor);

    if (outcome.status === 'continue' || outcome.status === 'yield') {
      return { status: 'catching-up', cursor: outcome.cursor };
    }

    const buffered = collector.drainAscending().filter(
      (candidate) => !this.recentKeys.has(candidate.key),
    );
    for (const candidate of buffered) this.recentKeys.add(candidate.key);
    if (this.pendingNewestKey !== undefined) this.watermark = this.pendingNewestKey;
    this.catchUp = undefined;
    this.pendingNewestKey = undefined;

    if (outcome.status === 'possible-gap') {
      return { status: 'possible-gap', items: buffered.map((candidate) => candidate.raw) };
    }

    return {
      status: 'events',
      delivery: 'recovered',
      items: buffered.map((candidate) => candidate.raw),
    };
  }

  private acceptAsCurrent(candidates: readonly BufferedPumpTrade[]): void {
    for (const candidate of candidates) this.recentKeys.add(candidate.key);
    if (candidates[0] !== undefined) this.watermark = candidates[0].key;
  }
}

function toCandidate(raw: RawPumpTrade): BufferedPumpTrade {
  return {
    raw,
    key: pumpTransactionKey(raw.chainId, raw.trade.tx),
    occurredAt: Date.parse(raw.trade.timestamp),
  };
}

function oldestFirst(items: readonly BufferedPumpTrade[]): BufferedPumpTrade[] {
  return [...items].sort(
    (left, right) => left.occurredAt - right.occurredAt || left.key.localeCompare(right.key),
  );
}
