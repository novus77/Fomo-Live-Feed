export type MarketCapRangeParseResult =
  | { ok: true; minimum: number | undefined; maximum: number | undefined }
  | { ok: false; reason: 'invalid-number' | 'reversed-range' };

const K_TO_USD = 1_000;
const DECIMAL_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

function parseKValue(draft: string): number | undefined | null {
  const normalized = draft.trim();

  if (normalized.length === 0) {
    return undefined;
  }

  if (!DECIMAL_PATTERN.test(normalized)) {
    return null;
  }

  const value = Number(normalized);
  const usdValue = value * K_TO_USD;

  if (!Number.isFinite(value) || value < 0 || !Number.isFinite(usdValue)) {
    return null;
  }

  return usdValue;
}

/** Parses non-negative K-denominated market-cap draft values into USD bounds. */
export function parseMarketCapRange(
  minimumDraft: string,
  maximumDraft: string,
): MarketCapRangeParseResult {
  const minimum = parseKValue(minimumDraft);
  const maximum = parseKValue(maximumDraft);

  if (minimum === null || maximum === null) {
    return { ok: false, reason: 'invalid-number' };
  }

  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    return { ok: false, reason: 'reversed-range' };
  }

  return { ok: true, minimum, maximum };
}
