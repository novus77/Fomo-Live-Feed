import type { ChainKey } from '../domain/activity';

export interface ChainPresentation {
  label: string;
  colorToken: `--chain-${string}`;
  color: `#${string}`;
}

export const CHAIN_PRESENTATION: Readonly<Record<ChainKey, ChainPresentation>> = {
  bsc: {
    label: 'BSC',
    colorToken: '--chain-bsc',
    color: '#f3ba2f',
  },
  solana: {
    label: 'SOL',
    colorToken: '--chain-solana',
    color: '#a855f7',
  },
  robinhood: {
    label: 'rh',
    colorToken: '--chain-robinhood',
    color: '#a3e635',
  },
  base: {
    label: 'Base',
    colorToken: '--chain-base',
    color: '#5793ff',
  },
  ethereum: {
    label: 'ETH',
    colorToken: '--chain-ethereum',
    color: '#8c8cdb',
  },
  'x-layer': {
    label: 'X Layer',
    colorToken: '--chain-x-layer',
    color: '#7c3aed',
  },
  unknown: {
    label: 'Unknown',
    colorToken: '--chain-unknown',
    color: '#94a3b8',
  },
};
