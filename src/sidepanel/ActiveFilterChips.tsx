import { ACTION_LABELS, CHAIN_LABELS } from '../popup/labels';
import type {
  PopupEventFilters,
  PopupTokenOption,
  PopupTraderOption,
} from '../popup/event-query';

export interface ActiveFilterChipsProps {
  filters: PopupEventFilters;
  traders: readonly PopupTraderOption[];
  tokens: readonly PopupTokenOption[];
  onFiltersChange(filters: PopupEventFilters): void;
}

export function ActiveFilterChips(props: ActiveFilterChipsProps) {
  const { filters, traders, tokens, onFiltersChange } = props;
  const chips: Array<{ key: string; label: string; clear: Partial<PopupEventFilters> }> = [];

  if (filters.unreadOnly) {
    chips.push({ key: 'unread', label: 'Unread', clear: { unreadOnly: false } });
  }
  if (filters.action !== undefined) {
    chips.push({
      key: 'action',
      label: `Action: ${ACTION_LABELS[filters.action]}`,
      clear: { action: undefined },
    });
  }
  if (filters.chain !== undefined) {
    chips.push({
      key: 'chain',
      label: `Chain: ${CHAIN_LABELS[filters.chain]}`,
      clear: { chain: undefined },
    });
  }
  if (filters.traderId !== undefined) {
    const trader = traders.find((candidate) => candidate.traderId === filters.traderId);
    chips.push({
      key: 'trader',
      label: `Trader: ${trader === undefined ? filters.traderId : `@${trader.handle}`}`,
      clear: { traderId: undefined },
    });
  }
  if (filters.tokenAddress !== undefined) {
    const token = tokens.find((candidate) => candidate.address === filters.tokenAddress);
    chips.push({
      key: 'token',
      label: `Token: ${token?.symbol ?? filters.tokenAddress}`,
      clear: { tokenAddress: undefined },
    });
  }

  if (chips.length === 0) {
    return null;
  }

  return (
    <div className="active-filter-chips" aria-label="Active filters">
      {chips.map((chip) => (
        <span className="active-filter-chip" key={chip.key}>
          <span>{chip.label}</span>
          <button
            type="button"
            aria-label={`Remove ${chip.label} filter`}
            onClick={() => {
              onFiltersChange({ ...filters, ...chip.clear });
            }}
          >
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
