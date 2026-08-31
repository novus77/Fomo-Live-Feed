import type { ChainKey } from '../domain/activity';

export type FilterableChain = Exclude<ChainKey, 'unknown'>;

export const FILTERABLE_CHAINS = [
  'bsc',
  'solana',
  'base',
  'robinhood',
  'ethereum',
  'x-layer',
] as const satisfies readonly FilterableChain[];

const FILTERABLE_CHAIN_SET: ReadonlySet<ChainKey> = new Set(FILTERABLE_CHAINS);

export function normalizeMutedChains(values: readonly unknown[]): FilterableChain[] {
  const input = new Set(
    values.filter(
      (value): value is FilterableChain =>
        typeof value === 'string' && FILTERABLE_CHAIN_SET.has(value as ChainKey),
    ),
  );

  return FILTERABLE_CHAINS.filter((chain) => input.has(chain));
}

export function toVisibleChains(muted: readonly unknown[]): FilterableChain[] {
  const normalized = new Set(normalizeMutedChains(muted));

  return FILTERABLE_CHAINS.filter((chain) => !normalized.has(chain));
}

export function toMutedChains(visible: readonly FilterableChain[]): FilterableChain[] {
  const selected = new Set(visible);

  return FILTERABLE_CHAINS.filter((chain) => !selected.has(chain));
}

export function toggleVisibleChain(
  visible: readonly FilterableChain[],
  chain: FilterableChain,
): FilterableChain[] {
  const selected = new Set(visible);

  if (selected.has(chain)) {
    selected.delete(chain);
  } else {
    selected.add(chain);
  }

  return FILTERABLE_CHAINS.filter((candidate) => selected.has(candidate));
}
