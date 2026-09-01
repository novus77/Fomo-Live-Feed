import type { ChainKey } from '../domain/activity';

const CHAIN_ICON_PATHS: Partial<Record<ChainKey, string>> = {
  bsc: '/chains/bsc.svg',
  solana: '/chains/solana.svg',
  robinhood: '/chains/robinhood.svg',
  base: '/chains/base.svg',
  ethereum: '/chains/ethereum.svg',
  'x-layer': '/chains/xlayer.svg',
};

export function ChainIcon(props: { chain: ChainKey; className?: string }) {
  const src = CHAIN_ICON_PATHS[props.chain];

  if (src === undefined) return null;

  return (
    <img
      className={`chain-icon${props.className === undefined ? '' : ` ${props.className}`}`}
      src={src}
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}
