import { describe, expect, it } from 'vitest';

import {
  FILTERABLE_CHAINS,
  normalizeMutedChains,
  toMutedChains,
  toVisibleChains,
  toggleVisibleChain,
} from '../../src/sidepanel/chain-visibility';

describe('chain visibility', () => {
  it('exposes every approved chain in UI order', () => {
    expect(FILTERABLE_CHAINS).toEqual([
      'bsc',
      'solana',
      'base',
      'arc',
      'robinhood',
      'ethereum',
      'x-layer',
    ]);
  });

  it('drops unknown, duplicates, and unsupported stored values', () => {
    expect(normalizeMutedChains(['unknown', 'bsc', 'bsc', 'monad'])).toEqual(['bsc']);
  });

  it('round-trips visible and muted sets in canonical order', () => {
    expect(toVisibleChains(['base', 'bsc'])).toEqual([
      'solana',
      'arc',
      'robinhood',
      'ethereum',
      'x-layer',
    ]);
    expect(toMutedChains(['solana', 'ethereum'])).toEqual([
      'bsc',
      'base',
      'arc',
      'robinhood',
      'x-layer',
    ]);
  });

  it('toggles without mutating the input and preserves canonical order', () => {
    const visible = [...FILTERABLE_CHAINS];

    expect(toggleVisibleChain(visible, 'base')).toEqual([
      'bsc',
      'solana',
      'arc',
      'robinhood',
      'ethereum',
      'x-layer',
    ]);
    expect(visible).toEqual(FILTERABLE_CHAINS);
  });
});
