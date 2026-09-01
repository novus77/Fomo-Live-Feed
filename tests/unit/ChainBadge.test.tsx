import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ChainKey } from '../../src/domain/activity';
import { ChainBadge } from '../../src/sidepanel/ChainBadge';
import { CHAIN_PRESENTATION } from '../../src/sidepanel/chain-presentation';

describe('ChainBadge', () => {
  it('uses the approved compact labels', () => {
    expect(CHAIN_PRESENTATION.ethereum.label).toBe('ETH');
    expect(CHAIN_PRESENTATION.solana.label).toBe('SOL');
    expect(CHAIN_PRESENTATION.robinhood.label).toBe('rh');
  });

  it.each([
    ['bsc', '/chains/bsc.svg'],
    ['solana', '/chains/solana.svg'],
    ['robinhood', '/chains/robinhood.svg'],
    ['base', '/chains/base.svg'],
    ['ethereum', '/chains/ethereum.svg'],
    ['x-layer', '/chains/xlayer.svg'],
  ] as const)('renders approved local artwork for %s', (chain, src) => {
    const { container } = render(<ChainBadge chain={chain} />);
    const badge = screen.getByText(CHAIN_PRESENTATION[chain].label);
    const image = container.querySelector<HTMLImageElement>('.chain-icon');

    expect(CHAIN_PRESENTATION[chain].colorToken).toMatch(/^--chain-/);
    expect(CHAIN_PRESENTATION[chain].color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(badge).toBeVisible();
    expect(image).toHaveAttribute('src', src);
    expect(image).toHaveAttribute('alt', '');
    expect(container.querySelector('svg')).not.toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/https?:\/\//);
  });

  it('does not request artwork for an unknown chain', () => {
    const { container } = render(<ChainBadge chain={'unknown' satisfies ChainKey} />);

    expect(container.querySelector('.chain-icon')).not.toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeVisible();
  });
});
