import { useLocale } from '../i18n/LocaleProvider';
import {
  FILTERABLE_CHAINS,
  toggleVisibleChain,
  type FilterableChain,
} from './chain-visibility';

const FILTER_LABELS: Readonly<Record<FilterableChain, string>> = {
  bsc: 'BSC',
  solana: 'Solana',
  base: 'Base',
  robinhood: 'RH',
  ethereum: 'Ethereum',
  'x-layer': 'X Layer',
};

export interface ChainVisibilityFilterProps {
  visibleChains: readonly FilterableChain[];
  onChange(visibleChains: FilterableChain[]): void;
}

export function ChainVisibilityFilter({
  visibleChains,
  onChange,
}: ChainVisibilityFilterProps) {
  const { translate } = useLocale();
  const allSelected = FILTERABLE_CHAINS.every((chain) => visibleChains.includes(chain));

  return (
    <div className="feed-filter-section">
      <div className="feed-filter-heading">
        <span className="feed-filter-label">{translate('feed.filterChains')}</span>
        <button
          type="button"
          className="feed-filter-bulk"
          onClick={() => onChange(allSelected ? [] : [...FILTERABLE_CHAINS])}
        >
          {translate(allSelected ? 'feed.deselectAll' : 'feed.selectAll')}
        </button>
      </div>
      <div
        className="feed-filter-chains"
        role="group"
        aria-label={translate('feed.filterChains')}
      >
        {FILTERABLE_CHAINS.map((chain) => {
          const selected = visibleChains.includes(chain);

          return (
            <button
              key={chain}
              type="button"
              className="feed-filter-chain"
              aria-pressed={selected}
              onClick={() => onChange(toggleVisibleChain(visibleChains, chain))}
            >
              <span aria-hidden="true" className="feed-filter-check">
                {selected ? '✓' : ''}
              </span>
              {FILTER_LABELS[chain]}
            </button>
          );
        })}
      </div>
    </div>
  );
}
