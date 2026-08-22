import { describe, expect, it } from 'vitest';

import {
  UNAVAILABLE,
  formatCount,
  formatDuration,
  formatFollowers,
  formatPnl,
  formatRelativeTime,
  formatUsd,
  formatWinRate,
} from '../../src/overlay/format';

const NOW = 1_800_000_000_000;

describe('formatRelativeTime', () => {
  it('renders "just now" within the first minute', () => {
    expect(formatRelativeTime(NOW, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - 1, NOW)).toBe('just now');
    expect(formatRelativeTime(NOW - 59_000, NOW)).toBe('just now');
  });

  it('renders minutes between 1 and 59 minutes old', () => {
    expect(formatRelativeTime(NOW - 60_000, NOW)).toBe('1m ago');
    expect(formatRelativeTime(NOW - 59 * 60_000, NOW)).toBe('59m ago');
  });

  it('renders hours between 1 and 23 hours old', () => {
    expect(formatRelativeTime(NOW - 60 * 60_000, NOW)).toBe('1h ago');
    expect(formatRelativeTime(NOW - 23 * 60 * 60_000, NOW)).toBe('23h ago');
  });

  it('renders days from 24 hours old onwards', () => {
    expect(formatRelativeTime(NOW - 24 * 60 * 60_000, NOW)).toBe('1d ago');
    expect(formatRelativeTime(NOW - 2 * 24 * 60 * 60_000, NOW)).toBe('2d ago');
  });

  it('clamps future timestamps to "just now" instead of a negative value', () => {
    expect(formatRelativeTime(NOW + 5_000, NOW)).toBe('just now');
  });

  it('renders Unavailable for a missing or invalid timestamp', () => {
    expect(formatRelativeTime(undefined, NOW)).toBe(UNAVAILABLE);
    expect(formatRelativeTime(Number.NaN, NOW)).toBe(UNAVAILABLE);
  });
});

describe('formatUsd', () => {
  it('renders plain dollars under one thousand', () => {
    expect(formatUsd(0)).toBe('$0');
    expect(formatUsd(842)).toBe('$842');
    expect(formatUsd(999)).toBe('$999');
    expect(formatUsd(999.4)).toBe('$999');
  });

  it('rolls a value that rounds to 1000 into the compact K unit', () => {
    expect(formatUsd(999.6)).toBe('$1K');
    expect(formatUsd(999.5)).toBe('$1K');
    expect(formatCount(999.6)).toBe('1K');
  });

  it('renders compact thousands', () => {
    expect(formatUsd(1_000)).toBe('$1K');
    expect(formatUsd(1_250)).toBe('$1.25K');
    expect(formatUsd(12_500)).toBe('$12.5K');
  });

  it('renders compact millions and billions', () => {
    expect(formatUsd(1_000_000)).toBe('$1M');
    expect(formatUsd(2_500_000)).toBe('$2.5M');
    expect(formatUsd(1_000_000_000)).toBe('$1B');
  });

  it('promotes a rounded boundary to the next unit', () => {
    expect(formatUsd(999_999)).toBe('$1M');
  });

  it('renders Unavailable for a missing or invalid amount', () => {
    expect(formatUsd(undefined)).toBe(UNAVAILABLE);
    expect(formatUsd(Number.POSITIVE_INFINITY)).toBe(UNAVAILABLE);
  });
});

describe('formatPnl (sign handling)', () => {
  it('prefixes a positive PnL with a plus sign', () => {
    expect(formatPnl(1_250)).toBe('+$1.25K');
    expect(formatPnl(5)).toBe('+$5');
  });

  it('prefixes a negative PnL with a minus sign', () => {
    expect(formatPnl(-500)).toBe('-$500');
    expect(formatPnl(-1_250)).toBe('-$1.25K');
  });

  it('renders zero without a sign', () => {
    expect(formatPnl(0)).toBe('$0');
  });

  it('renders Unavailable for a missing or invalid PnL', () => {
    expect(formatPnl(undefined)).toBe(UNAVAILABLE);
  });
});

describe('formatWinRate', () => {
  it('renders the win rate as a percentage, trimming trailing zeros', () => {
    expect(formatWinRate(65)).toBe('65%');
    expect(formatWinRate(62.5)).toBe('62.5%');
    expect(formatWinRate(0)).toBe('0%');
    expect(formatWinRate(100)).toBe('100%');
  });

  it('rounds to at most one decimal place', () => {
    expect(formatWinRate(62.53)).toBe('62.5%');
    expect(formatWinRate(62.56)).toBe('62.6%');
  });

  it('renders Unavailable for a missing or invalid win rate', () => {
    expect(formatWinRate(undefined)).toBe(UNAVAILABLE);
    expect(formatWinRate(Number.NaN)).toBe(UNAVAILABLE);
  });
});

describe('formatCount', () => {
  it('renders plain counts under one thousand', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(842)).toBe('842');
  });

  it('renders compact counts', () => {
    expect(formatCount(1_250)).toBe('1.25K');
    expect(formatCount(2_500_000)).toBe('2.5M');
  });

  it('renders Unavailable for a missing count', () => {
    expect(formatCount(undefined)).toBe(UNAVAILABLE);
  });
});

describe('formatFollowers', () => {
  it('formats finite non-negative integers compactly', () => {
    expect(formatFollowers(0)).toBe('0');
    expect(formatFollowers(842)).toBe('842');
    expect(formatFollowers(1_250)).toBe('1.25K');
    expect(formatFollowers(2_500_000)).toBe('2.5M');
  });

  it('returns undefined for missing, fractional, negative, or non-finite values', () => {
    expect(formatFollowers(undefined)).toBeUndefined();
    expect(formatFollowers(1.5)).toBeUndefined();
    expect(formatFollowers(-1)).toBeUndefined();
    expect(formatFollowers(Number.NaN)).toBeUndefined();
    expect(formatFollowers(Number.POSITIVE_INFINITY)).toBeUndefined();
  });
});

describe('formatDuration', () => {
  it('renders seconds under a minute', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45)).toBe('45s');
  });

  it('renders minutes under an hour', () => {
    expect(formatDuration(90)).toBe('1m');
    expect(formatDuration(120)).toBe('2m');
  });

  it('renders hours and minutes', () => {
    expect(formatDuration(3_600)).toBe('1h');
    expect(formatDuration(4_800)).toBe('1h 20m');
    expect(formatDuration(86_400)).toBe('24h');
  });

  it('renders Unavailable for a missing or negative duration', () => {
    expect(formatDuration(undefined)).toBe(UNAVAILABLE);
    expect(formatDuration(-5)).toBe(UNAVAILABLE);
  });
});
