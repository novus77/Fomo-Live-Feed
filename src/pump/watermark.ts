const DEFAULT_RECENT_KEY_CAPACITY = 2_048;
const MAX_TRANSACTION_LENGTH = 128;

export function pumpTransactionKey(chainId: number, transactionHash: string): string {
  if (!Number.isInteger(chainId) || chainId < 0) {
    throw new TypeError('chainId must be a non-negative integer');
  }

  const normalizedHash = transactionHash.trim();
  if (normalizedHash.length === 0 || normalizedHash.length > MAX_TRANSACTION_LENGTH) {
    throw new TypeError('transactionHash must be a bounded non-empty string');
  }

  return `${chainId}:${normalizedHash}`;
}

export class PumpRecentKeys {
  private readonly ordered: string[] = [];
  private readonly keys = new Set<string>();

  constructor(
    seed: readonly string[] = [],
    private readonly capacity = DEFAULT_RECENT_KEY_CAPACITY,
  ) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new TypeError('capacity must be a positive integer');
    }

    for (const key of seed) {
      this.add(key);
    }
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  add(key: string): void {
    if (typeof key !== 'string' || key.length === 0) {
      throw new TypeError('key must be a non-empty string');
    }

    if (this.keys.has(key)) {
      return;
    }

    this.ordered.push(key);
    this.keys.add(key);

    while (this.ordered.length > this.capacity) {
      const evicted = this.ordered.shift();
      if (evicted !== undefined) {
        this.keys.delete(evicted);
      }
    }
  }

  values(): string[] {
    return [...this.ordered];
  }
}
