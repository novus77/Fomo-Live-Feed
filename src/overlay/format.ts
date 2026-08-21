import type { MetricKey } from '../domain/settings';
import type { MessageKey } from '../i18n/catalog';

/**
 * Shared display formatting for the toast overlay (plan Task 8).
 *
 * Every formatter is a pure function with the clock (and, for relative time,
 * the timestamp) injected as parameters, so unit tests are deterministic. A
 * missing or non-finite input NEVER renders as a zero or an invented value:
 * it renders the literal UNAVAILABLE string, matching the design rule that
 * missing metrics show as "Unavailable" (spec section 5.2).
 *
 * WIN-RATE UNIT ASSUMPTION: formatWinRate treats winRate7d as percentage
 * points (62.5 renders as "62.5%"). The enrichment adapter (plan Task 7) is
 * required to expose an explicit 7-day window; if a captured production
 * fixture ever proves the value arrives as a 0-1 fraction, this function and
 * the adapter's parser must change together in this one place.
 */
export const UNAVAILABLE = 'Unavailable';

/**
 * Message keys for the honest metric labels (spec section 5.2): only pnl7d
 * and winRate7d claim the 7-day window, and the lifetime metrics never
 * present themselves as 7-day. Components render `translate(METRIC_LABEL_KEYS[key])`
 * instead of the English literal so the label follows the UI locale.
 */
export const METRIC_LABEL_KEYS: Readonly<Record<MetricKey, MessageKey>> = {
  pnl7d: 'metric.pnl7d',
  winRate7d: 'metric.winRate7d',
  followers: 'metric.followers',
  tradeCount: 'metric.tradeCount',
  averageHoldSeconds: 'metric.averageHoldSeconds',
};

const isUsableNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "just now", "2m ago", "1h ago", "3d ago". Future timestamps clamp to "just now". */
export function formatRelativeTime(
  occurredAt: number | undefined,
  now: number,
): string {
  if (!isUsableNumber(occurredAt) || !isUsableNumber(now)) {
    return UNAVAILABLE;
  }

  const deltaMs = now - occurredAt;

  if (deltaMs < MINUTE_MS) {
    return 'just now';
  }

  const minutes = Math.floor(deltaMs / MINUTE_MS);

  if (minutes < 60) {
    return minutes + 'm ago';
  }

  const hours = Math.floor(minutes / 60);

  if (hours < 24) {
    return hours + 'h ago';
  }

  return Math.floor(hours / 24) + 'd ago';
}

/** Rounds to at most two decimals and trims trailing zeros ("1.25", "2"). */
function trimNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

const COMPACT_UNITS = [
  { divisor: 1_000_000_000, suffix: 'B' },
  { divisor: 1_000_000, suffix: 'M' },
  { divisor: 1_000, suffix: 'K' },
] as const;

/**
 * "842", "1.25K", "2.5M"; promotes a rounded boundary (999.999K -> 1M) AND
 * rolls a value that rounds to exactly 1000 (999.6 -> "1K") into the compact
 * K unit instead of rendering the literal "$1000".
 */
function formatCompactNumber(value: number): string {
  const roundedValue = Math.round(value);

  if (roundedValue < 1_000) {
    return String(roundedValue);
  }

  for (let index = 0; index < COMPACT_UNITS.length; index += 1) {
    const unit = COMPACT_UNITS[index];

    if (unit === undefined || roundedValue < unit.divisor) {
      continue;
    }

    const rounded = trimNumber(roundedValue / unit.divisor);

    if (rounded === '1000' && index > 0) {
      const next = COMPACT_UNITS[index - 1];

      if (next !== undefined) {
        return trimNumber(roundedValue / next.divisor) + next.suffix;
      }
    }

    return rounded + unit.suffix;
  }

  return String(roundedValue);
}

/** Compact USD: "$842", "$1.25K", "$2.5M". Negative magnitudes get a minus sign. */
export function formatUsd(value: number | undefined): string {
  if (!isUsableNumber(value)) {
    return UNAVAILABLE;
  }

  const sign = value < 0 ? '-' : '';

  return sign + '$' + formatCompactNumber(Math.abs(value));
}

/** Signed PnL: "+$1.25K" for gains, "-$500" for losses, "$0" for zero. */
export function formatPnl(value: number | undefined): string {
  if (!isUsableNumber(value)) {
    return UNAVAILABLE;
  }

  if (value > 0) {
    return '+' + formatUsd(value);
  }

  return formatUsd(value);
}

/** Win rate as percentage points, rounded to one decimal: "65%", "62.5%". */
export function formatWinRate(value: number | undefined): string {
  if (!isUsableNumber(value)) {
    return UNAVAILABLE;
  }

  return trimNumber(Math.round(value * 10) / 10) + '%';
}

/** Compact plain count: "842", "1.25K", "2.5M" (no currency prefix). */
export function formatCount(value: number | undefined): string {
  if (!isUsableNumber(value)) {
    return UNAVAILABLE;
  }

  return formatCompactNumber(Math.abs(value));
}

/** Compact duration from seconds: "45s", "2m", "1h", "1h 20m". */
export function formatDuration(seconds: number | undefined): string {
  if (!isUsableNumber(seconds) || seconds < 0) {
    return UNAVAILABLE;
  }

  const totalSeconds = Math.floor(seconds);

  if (totalSeconds < 60) {
    return totalSeconds + 's';
  }

  const totalMinutes = Math.floor(totalSeconds / 60);

  if (totalMinutes < 60) {
    return totalMinutes + 'm';
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (minutes === 0) {
    return hours + 'h';
  }

  return hours + 'h ' + minutes + 'm';
}

/**
 * Honest metric label: only pnl7d and winRate7d claim the 7-day window, and
 * the lifetime metrics never present themselves as 7-day (spec section 5.2).
 */
export function formatMetricLabel(key: MetricKey): string {
  switch (key) {
    case 'pnl7d':
      return '7d PnL';
    case 'winRate7d':
      return '7d Win Rate';
    case 'followers':
      return 'Followers';
    case 'tradeCount':
      return 'Trades';
    case 'averageHoldSeconds':
      return 'Avg Hold';
  }
}

/** Formats a metric value with the key's own rules; missing values are Unavailable. */
export function formatMetricValue(
  key: MetricKey,
  value: number | undefined,
): string {
  switch (key) {
    case 'pnl7d':
      return formatPnl(value);
    case 'winRate7d':
      return formatWinRate(value);
    case 'followers':
      return formatCount(value);
    case 'tradeCount':
      return formatCount(value);
    case 'averageHoldSeconds':
      return formatDuration(value);
  }
}
