import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ChainKey } from '../../src/domain/activity';
import { ChainBadge } from '../../src/sidepanel/ChainBadge';
import { CHAIN_PRESENTATION } from '../../src/sidepanel/chain-presentation';

describe('ChainBadge', () => {
  it('uses the approved compact labels', () => {
    expect(CHAIN_PRESENTATION.ethereum.label).toBe('ETH');
    expect(CHAIN_PRESENTATION.solana.label).toBe('SOL');
    expect(CHAIN_PRESENTATION.robinhood.label).toBe('Robinhood');
  });

  it.each<ChainKey>([
    'bsc',
    'solana',
    'robinhood',
    'base',
    'ethereum',
    'x-layer',
    'unknown',
  ])(
    'renders an accessible local badge for %s',
    (chain) => {
      const { container } = render(<ChainBadge chain={chain} />);
      const badge = screen.getByText(CHAIN_PRESENTATION[chain].label);

      expect(CHAIN_PRESENTATION[chain].label).not.toBe('');
      expect(CHAIN_PRESENTATION[chain].colorToken).toMatch(/^--chain-/);
      expect(CHAIN_PRESENTATION[chain].color).toMatch(/^#[0-9a-f]{6}$/i);
      expect(badge).toBeVisible();
      expect(container.querySelector('svg')).toBeInTheDocument();
      expect(container.querySelector('img')).toBeNull();
      expect(container.innerHTML).not.toMatch(/https?:\/\//);
    },
  );
});
