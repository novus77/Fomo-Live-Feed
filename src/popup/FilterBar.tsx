import { ACTIONS, ACTION_LABELS, CHAIN_KEYS, CHAIN_LABELS } from './labels';
import type {
  PopupEventFilters,
  PopupTokenOption,
  PopupTraderOption,
} from './event-query';

/**
 * Filter and search bar (plan Task 9, spec section 7.3).
 *
 * Unread/chain/trader/token filters execute in the storage query; action
 * and the free-text search are popup-side post-filters (see event-query.ts).
 * The pinned-first toggle only re-sorts the already-loaded rows.
 */
export interface FilterBarProps {
  filters: PopupEventFilters;
  onChange(filters: PopupEventFilters): void;
  pinnedFirst: boolean;
  onPinnedFirstChange(value: boolean): void;
  traders: readonly PopupTraderOption[];
  tokens: readonly PopupTokenOption[];
}

export function FilterBar(props: FilterBarProps) {
  const { filters, onChange, pinnedFirst, onPinnedFirstChange, traders, tokens } = props;

  const update = (patch: Partial<PopupEventFilters>): void => {
    onChange({ ...filters, ...patch });
  };

  return (
    <div className="filter-bar">
      <input
        type="search"
        className="filter-search"
        placeholder="Search traders, labels, symbols, addresses"
        aria-label="Search history"
        value={filters.search}
        onChange={(event) => {
          update({ search: event.target.value });
        }}
      />

      <div className="filter-row">
        <label className="filter-check">
          <input
            type="checkbox"
            checked={filters.unreadOnly}
            onChange={(event) => {
              update({ unreadOnly: event.target.checked });
            }}
          />
          Unread only
        </label>
        <label className="filter-check">
          <input
            type="checkbox"
            checked={pinnedFirst}
            onChange={(event) => {
              onPinnedFirstChange(event.target.checked);
            }}
          />
          Pinned first
        </label>
      </div>

      <div className="filter-row">
        <label className="filter-select">
          <span>Action</span>
          <select
            aria-label="Action filter"
            value={filters.action ?? 'all'}
            onChange={(event) => {
              const value = event.target.value;

              update({ action: value === 'all' ? undefined : (value as PopupEventFilters['action']) });
            }}
          >
            <option value="all">All actions</option>
            {ACTIONS.map((action) => (
              <option key={action} value={action}>
                {ACTION_LABELS[action]}
              </option>
            ))}
          </select>
        </label>

        <label className="filter-select">
          <span>Chain</span>
          <select
            aria-label="Chain filter"
            value={filters.chain ?? 'all'}
            onChange={(event) => {
              const value = event.target.value;

              update({ chain: value === 'all' ? undefined : (value as PopupEventFilters['chain']) });
            }}
          >
            <option value="all">All chains</option>
            {CHAIN_KEYS.map((chain) => (
              <option key={chain} value={chain}>
                {CHAIN_LABELS[chain]}
              </option>
            ))}
          </select>
        </label>

        <label className="filter-select">
          <span>Trader</span>
          <select
            aria-label="Trader filter"
            value={filters.traderId ?? 'all'}
            onChange={(event) => {
              const value = event.target.value;

              update({ traderId: value === 'all' ? undefined : value });
            }}
          >
            <option value="all">All traders</option>
            {traders.map((trader) => (
              <option key={trader.traderId} value={trader.traderId}>
                @{trader.handle}
              </option>
            ))}
          </select>
        </label>

        <label className="filter-select">
          <span>Token</span>
          <select
            aria-label="Token filter"
            value={filters.tokenAddress ?? 'all'}
            onChange={(event) => {
              const value = event.target.value;

              update({ tokenAddress: value === 'all' ? undefined : value });
            }}
          >
            <option value="all">All tokens</option>
            {tokens.map((token) => (
              <option key={token.address} value={token.address}>
                {token.symbol}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
