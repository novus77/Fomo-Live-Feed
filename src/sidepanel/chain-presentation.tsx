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
  solana: {
    label: 'Solana',
    colorToken: '--chain-solana',
    color: '#14f195',
    icon: icon(<path fill="currentColor" d="M3 3h10l-2 2H1l2-2Zm2 4h10l-2 2H3l2-2Zm-2 4h10l2 2H5l-2-2Z" />),
  },
  ethereum: {
    label: 'Ethereum',
    colorToken: '--chain-ethereum',
    color: '#8c8cdb',
    icon: icon(<path fill="currentColor" d="m8 1 4 7-4 2-4-2 4-7Zm0 10 4-2-4 6-4-6 4 2Z" />),
  },
  bsc: {
    label: 'BSC',
    colorToken: '--chain-bsc',
    color: '#f3ba2f',
    icon: icon(<path fill="currentColor" d="m8 1 3 3-2 2-1-1-1 1-2-2 3-3Zm4 4 3 3-3 3-2-2 1-1-1-1 2-2ZM4 5l2 2-1 1 1 1-2 2-3-3 3-3Zm4 4 2 2-2 2-2-2 2-2Z" />),
  },
  base: {
    label: 'Base',
    colorToken: '--chain-base',
    color: '#5793ff',
    icon: icon(<path fill="currentColor" d="M8 2a6 6 0 1 0 5.66 8H9.5a2 2 0 1 1 0-4h4.16A6 6 0 0 0 8 2Z" />),
  },
  monad: {
    label: 'Monad',
    colorToken: '--chain-monad',
    color: '#a78bfa',
    icon: icon(<path fill="none" stroke="currentColor" strokeWidth="2" d="M2.5 12.5 4 4l4 3 4-3 1.5 8.5-5.5 2-5.5-2Z" />),
  },
  unknown: {
    label: 'Unknown',
    colorToken: '--chain-unknown',
    color: '#94a3b8',
    icon: icon(<path fill="currentColor" d="M7 11h2v2H7v-2Zm1-9a4 4 0 0 1 2.1 7.4c-.83.5-1.1.8-1.1 1.1H7c0-1.47.88-2.13 2.07-2.85A2 2 0 1 0 6 5.96H4A4 4 0 0 1 8 2Z" />),
  },
};
