export type PumpBackoffFailure = 'rate-limit' | 'timeout' | 'network' | 'server';

const RATE_LIMIT_DELAYS = [3_000, 5_000, 10_000, 30_000, 60_000] as const;
const MAX_TRANSPORT_LEVEL = 8;
const MAX_DELAY_MS = 60_000;

const boundedRandom = (value: number): number => {
  if (!Number.isFinite(value)) {
    return 0.5;
  }
  return Math.min(1, Math.max(0, value));
};

export function nextPumpDelay(input: {
  failure: PumpBackoffFailure;
  level: number;
  retryAfterMs?: number;
  random: number;
}): { delayMs: number; level: number } {
  const currentLevel = Number.isInteger(input.level) && input.level >= 0
    ? input.level
    : 0;
  const isRateLimit = input.failure === 'rate-limit';
  const baseDelay = isRateLimit
    ? RATE_LIMIT_DELAYS[Math.min(currentLevel, RATE_LIMIT_DELAYS.length - 1)]!
    : Math.min(MAX_DELAY_MS, 1_000 * (2 ** Math.min(currentLevel, 6)));
  const jitterFactor = 0.8 + boundedRandom(input.random) * 0.4;
  const jitteredDelay = Math.round(baseDelay * jitterFactor);
  const validServerMinimum = input.retryAfterMs !== undefined &&
    Number.isFinite(input.retryAfterMs) && input.retryAfterMs >= 0
    ? Math.round(input.retryAfterMs)
    : 0;

  return {
    delayMs: Math.max(validServerMinimum, jitteredDelay),
    level: isRateLimit
      ? Math.min(currentLevel + 1, RATE_LIMIT_DELAYS.length - 1)
      : Math.min(currentLevel + 1, MAX_TRANSPORT_LEVEL),
  };
}

export function reduceBackoffAfterSuccess(
  level: number,
  previousSuccesses: number,
): { level: number; successes: number } {
  const successes = previousSuccesses + 1;

  if (successes < 3) {
    return { level: Math.max(0, level), successes };
  }

  return { level: Math.max(0, level - 1), successes: 0 };
}
