import { describe, expect, it } from 'vitest';

import { parseMarketCapRange } from '../../src/sidepanel/market-cap-range';

describe('parseMarketCapRange', () => {
  it('accepts empty, one-sided, and decimal K-denominated values', () => {
    expect(parseMarketCapRange('', '')).toEqual({
      ok: true,
      minimum: undefined,
      maximum: undefined,
    });
    expect(parseMarketCapRange('200', '500')).toEqual({
      ok: true,
      minimum: 200_000,
      maximum: 500_000,
    });
    expect(parseMarketCapRange('12.5', '')).toEqual({
      ok: true,
      minimum: 12_500,
      maximum: undefined,
    });
    expect(parseMarketCapRange('', '500')).toEqual({
      ok: true,
      minimum: undefined,
      maximum: 500_000,
    });
  });

  it('rejects invalid, negative, non-finite, and reversed values', () => {
    expect(parseMarketCapRange('-1', '')).toEqual({ ok: false, reason: 'invalid-number' });
    expect(parseMarketCapRange('1e3', '')).toEqual({ ok: false, reason: 'invalid-number' });
    expect(parseMarketCapRange('Infinity', '')).toEqual({ ok: false, reason: 'invalid-number' });
    expect(parseMarketCapRange('500', '200')).toEqual({ ok: false, reason: 'reversed-range' });
  });
});
