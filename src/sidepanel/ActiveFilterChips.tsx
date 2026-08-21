import { useLocale } from '../i18n/LocaleProvider';
import { ACTION_LABEL_KEYS, CHAIN_LABELS } from '../overlay/presentation';
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
  const { translate } = useLocale();
  const chips: Array<{ key: string; label: string; clear: Partial<PopupEventFilters> }> = [];

  if (filters.unreadOnly) {
    chips.push({ key: 'unread', label: translate('feed.unread'), clear: { unreadOnly: false } });
  }
  if (filters.action !== undefined) {
    chips.push({
      key: 'action',
      label: translate('feed.chipAction', {
        label: translate(ACTION_LABEL_KEYS[filters.action]),
      }),
      clear: { action: undefined },
    });
  }
  if (filters.chain !== undefined) {
    chips.push({
      key: 'chain',
      label: translate('feed.chipChain', { label: CHAIN_LABELS[filters.chain] }),
      clear: { chain: undefined },
    });
  }
  if (filters.traderId !== undefined) {
    const trader = traders.find((candidate) => candidate.traderId === filters.traderId);
    chips.push({
      key: 'trader',
      // The trader handle is untrusted user content: only the "Trader:" label
      // is extension-owned and translated.
      label: translate('feed.chipTrader', {
        label: trader === undefined ? filters.traderId : `@${trader.handle}`,
      }),
      clear: { traderId: undefined },
    });
  }
  if (filters.tokenAddress !== undefined) {
    const token = tokens.find((candidate) => candidate.address === filters.tokenAddress);
    chips.push({
      key: 'token',
      // The token symbol is untrusted user content: only the "Token:" label
      // is extension-owned and translated.
      label: translate('feed.chipToken', {
        label: token?.symbol ?? filters.tokenAddress,
      }),
      clear: { tokenAddress: undefined },
    });
  }

  if (chips.length === 0) {
    return null;
  }

  return (
    <div className="active-filter-chips" aria-label={translate('feed.activeFilters')}>
      {chips.map((chip) => (
        <span className="active-filter-chip" key={chip.key}>
          <span>{chip.label}</span>
          <button
            type="button"
            aria-label={translate('feed.removeFilter', { label: chip.label })}
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
