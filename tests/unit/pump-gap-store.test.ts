import { describe, expect, it } from 'vitest';

import {
  PUMP_GAP_STORAGE_KEY,
  parsePumpGapState,
} from '../../src/background/pump-gap-store';

describe('Pump gap storage boundary', () => {
  it('accepts an unresolved gap without treating a later live status as a repair', () => {
    expect(PUMP_GAP_STORAGE_KEY).toBe('pump.gap.v1');
    expect(parsePumpGapState({
      schemaVersion: 1,
      hasUnresolvedGap: true,
      lastGapAt: 100,
      reason: 'cursor-loop',
    })).toEqual({
      schemaVersion: 1,
      hasUnresolvedGap: true,
      lastGapAt: 100,
      reason: 'cursor-loop',
    });
  });

  it.each([
    null,
    {},
    { schemaVersion: 1, hasUnresolvedGap: false, lastGapAt: 1 },
    { schemaVersion: 1, hasUnresolvedGap: true },
    { schemaVersion: 1, hasUnresolvedGap: true, lastGapAt: -1 },
    { schemaVersion: 1, hasUnresolvedGap: true, lastGapAt: 1, reason: 'unknown' },
    { schemaVersion: 1, hasUnresolvedGap: true, lastGapAt: 1, extra: true },
  ])('rejects invalid or ambiguous state %#', (value) => {
    expect(parsePumpGapState(value)).toBeUndefined();
  });
});
