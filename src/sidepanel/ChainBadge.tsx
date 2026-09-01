import type { CSSProperties } from 'react';

import type { ChainKey } from '../domain/activity';
import { ChainIcon } from './ChainIcon';
import { CHAIN_PRESENTATION } from './chain-presentation';

export interface ChainBadgeProps {
  chain: ChainKey;
  className?: string;
}

export function ChainBadge({ chain, className }: ChainBadgeProps) {
  const presentation = CHAIN_PRESENTATION[chain] ?? CHAIN_PRESENTATION.unknown;
  const style = {
    '--chain-color': `var(${presentation.colorToken}, ${presentation.color})`,
  } as CSSProperties;

  return (
    <span className={['chain-badge', className].filter(Boolean).join(' ')} style={style}>
      <ChainIcon chain={chain} className="chain-icon-feed" />
      <span>{presentation.label}</span>
    </span>
  );
}
