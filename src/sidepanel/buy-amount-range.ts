export type BuyAmountRangeParseResult =
  | { ok: true; minimum: number | undefined; maximum: number | undefined }
  | { ok: false; reason: 'invalid-number' | 'reversed-range' };

const DECIMAL_PATTERN = /^(?:\d+(?:\.\d*)?|\.\d+)$/;

function parseUsdValue(draft: string): number | undefined | null {
  const normalized = draft.trim();

  if (normalized.length === 0) {
    return undefined;
  }

  if (!DECIMAL_PATTERN.test(normalized)) {
    return null;
  }

  const value = Number(normalized);

  if (!Number.isFinite(value) || value < 0) {
    return null;
  }

  return value;
}

/** Parses non-negative USD-denominated buy amount drafts into inclusive bounds. */
export function parseBuyAmountRange(
  minimumDraft: string,
  maximumDraft: string,
): BuyAmountRangeParseResult {
  const minimum = parseUsdValue(minimumDraft);
  const maximum = parseUsdValue(maximumDraft);

  if (minimum === null || maximum === null) {
    return { ok: false, reason: 'invalid-number' };
  }

  if (minimum !== undefined && maximum !== undefined && minimum > maximum) {
    return { ok: false, reason: 'reversed-range' };
  }

  return { ok: true, minimum, maximum };
}
