import type { ReactNode } from 'react';

import type { ChainKey } from '../domain/activity';

export interface ChainPresentation {
  label: string;
  colorToken: `--chain-${string}`;
  color: `#${string}`;
  icon: ReactNode;
}

const icon = (path: ReactNode): ReactNode => (
  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
    {path}
  </svg>
);

export const CHAIN_PRESENTATION: Readonly<Record<ChainKey, ChainPresentation>> = {
  bsc: {
    label: 'BSC',
    colorToken: '--chain-bsc',
    color: '#f3ba2f',
    icon: icon(<path fill="currentColor" d="m8 1 3 3-2 2-1-1-1 1-2-2 3-3Zm4 4 3 3-3 3-2-2 1-1-1-1 2-2ZM4 5l2 2-1 1 1 1-2 2-3-3 3-3Zm4 4 2 2-2 2-2-2 2-2Z" />),
  },
  solana: {
    label: 'SOL',
    colorToken: '--chain-solana',
    color: '#14f195',
    icon: icon(<path fill="currentColor" d="M3 3h10l-2 2H1l2-2Zm2 4h10l-2 2H3l2-2Zm-2 4h10l2 2H5l-2-2Z" />),
  },
  robinhood: {
    label: 'RH',
    colorToken: '--chain-robinhood',
    color: '#00c805',
    icon: icon(<path fill="currentColor" d="M2 8a6 6 0 1 1 12 0 6 6 0 0 1-12 0Zm2.5 0a3.5 3.5 0 0 0 7 0 3.5 3.5 0 0 0-7 0Z" />),
  },
  base: {
    label: 'Base',
    colorToken: '--chain-base',
    color: '#5793ff',
    icon: icon(<path fill="currentColor" d="M8 2a6 6 0 1 0 5.66 8H9.5a2 2 0 1 1 0-4h4.16A6 6 0 0 0 8 2Z" />),
  },
  ethereum: {
    label: 'ETH',
    colorToken: '--chain-ethereum',
    color: '#8c8cdb',
    icon: icon(<path fill="currentColor" d="m8 1 4 7-4 2-4-2 4-7Zm0 10 4-2-4 6-4-6 4 2Z" />),
  },
  'x-layer': {
    label: 'X Layer',
    colorToken: '--chain-x-layer',
    color: '#7c3aed',
    icon: icon(<path fill="currentColor" d="M8 1.5 14.5 8 8 14.5 1.5 8 8 1.5Zm0 3L5 8l3 3.5L11 8 8 4.5Z" />),
  },
  unknown: {
    label: 'Unknown',
    colorToken: '--chain-unknown',
    color: '#94a3b8',
    icon: icon(<path fill="currentColor" d="M7 11h2v2H7v-2Zm1-9a4 4 0 0 1 2.1 7.4c-.83.5-1.1.8-1.1 1.1H7c0-1.47.88-2.13 2.07-2.85A2 2 0 1 0 6 5.96H4A4 4 0 0 1 8 2Z" />),
  },
};
