import {
  nextPumpDelay,
  reduceBackoffAfterSuccess,
} from '../../src/pump/backoff';

describe('nextPumpDelay', () => {
  it.each([
    [0, 3_000],
    [1, 5_000],
    [2, 10_000],
    [3, 30_000],
    [4, 60_000],
    [8, 60_000],
  ])('uses the bounded rate-limit ladder at level %s', (level, expected) => {
    expect(nextPumpDelay({
      failure: 'rate-limit',
      level,
      random: 0.5,
    })).toEqual({ delayMs: expected, level: Math.min(level + 1, 4) });
  });

  it('adds deterministic jitter and never violates Retry-After', () => {
    expect(nextPumpDelay({
      failure: 'rate-limit',
      level: 0,
      retryAfterMs: 8_000,
      random: 0,
    }).delayMs).toBe(8_000);

    expect(nextPumpDelay({
      failure: 'rate-limit',
      level: 0,
      random: 1,
    }).delayMs).toBe(3_600);
  });

  it('uses bounded exponential delays for transport failures', () => {
    expect(nextPumpDelay({ failure: 'network', level: 0, random: 0.5 })).toEqual({
      delayMs: 1_000,
      level: 1,
    });
    expect(nextPumpDelay({ failure: 'server', level: 8, random: 0.5 })).toEqual({
      delayMs: 60_000,
      level: 8,
    });
  });

  it('reduces one level only after three consecutive successes', () => {
    expect(reduceBackoffAfterSuccess(3, 1)).toEqual({ level: 3, successes: 2 });
    expect(reduceBackoffAfterSuccess(3, 2)).toEqual({ level: 2, successes: 0 });
    expect(reduceBackoffAfterSuccess(0, 2)).toEqual({ level: 0, successes: 0 });
  });
});
