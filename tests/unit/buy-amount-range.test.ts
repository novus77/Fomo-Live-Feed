import { describe, expect, it } from 'vitest';

import { parseBuyAmountRange } from '../../src/sidepanel/buy-amount-range';

describe('parseBuyAmountRange', () => {
  it('accepts empty, one-sided, zero, and decimal USD values', () => {
    expect(parseBuyAmountRange('', '')).toEqual({
      ok: true,
      minimum: undefined,
      maximum: undefined,
    });
    expect(parseBuyAmountRange('5', '')).toEqual({
      ok: true,
      minimum: 5,
      maximum: undefined,
    });
    expect(parseBuyAmountRange('0', '10.5')).toEqual({
      ok: true,
      minimum: 0,
      maximum: 10.5,
    });
  });

  it('rejects exponent notation, negative, non-finite, and reversed values', () => {
    expect(parseBuyAmountRange('1e3', '')).toEqual({ ok: false, reason: 'invalid-number' });
    expect(parseBuyAmountRange('-1', '')).toEqual({ ok: false, reason: 'invalid-number' });
    expect(parseBuyAmountRange('Infinity', '')).toEqual({ ok: false, reason: 'invalid-number' });
    expect(parseBuyAmountRange('10', '5')).toEqual({ ok: false, reason: 'reversed-range' });
  });
});
