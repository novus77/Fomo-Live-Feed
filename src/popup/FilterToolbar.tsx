import { useEffect, useRef, useState, type ReactNode } from 'react';

import { useLocale } from '../i18n/LocaleProvider';
import {
  DEFAULT_FILTERS,
  activeFilterCount,
  type PopupEventFilters,
  type PopupTokenOption,
  type PopupTraderOption,
} from './event-query';
import { ACTION_LABEL_KEYS } from '../overlay/presentation';
import { ACTIONS, CHAIN_KEYS, CHAIN_LABELS } from './labels';
import { ActiveFilterChips } from './ActiveFilterChips';

export interface FilterToolbarProps {
  filters: PopupEventFilters;
  pinnedFirst: boolean;
  traders: readonly PopupTraderOption[];
  tokens: readonly PopupTokenOption[];
  onFiltersChange(filters: PopupEventFilters): void;
  onPinnedFirstChange(value: boolean): void;
}

export function FilterToolbar(props: FilterToolbarProps) {
  const {
    filters,
    pinnedFirst,
    traders,
    tokens,
    onFiltersChange,
    onPinnedFirstChange,
  } = props;
  const { translate } = useLocale();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const count = activeFilterCount(filters);
  const hasResettableState = count > 0 || filters.search.length > 0 || pinnedFirst;

  const update = (patch: Partial<PopupEventFilters>): void => {
    onFiltersChange({ ...filters, ...patch });
  };

  useEffect(() => {
    if (!open) {
      return;
    }

    popoverRef.current?.querySelector('select')?.focus();

    const close = (returnFocus: boolean): void => {
      setOpen(false);
      if (returnFocus) {
        triggerRef.current?.focus();
      }
    };
    const onOutsideClick = (event: MouseEvent): void => {
      const target = event.target;
      if (
        target instanceof Node
        && !popoverRef.current?.contains(target)
        && !triggerRef.current?.contains(target)
      ) {
        const interactiveTarget = target instanceof Element
          ? target.closest('a[href], button, input, select, textarea, label, summary, [contenteditable], [tabindex]:not([tabindex="-1"])')
          : null;
        close(interactiveTarget === null);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    };

    document.addEventListener('click', onOutsideClick);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('click', onOutsideClick);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const filterButtonLabel =
    count === 0 ? translate('feed.filters') : translate('feed.countActive', { count });

  return (
    <div className="filter-toolbar-block">
      <input
        type="search"
        className="filter-search"
        placeholder={translate('feed.searchPlaceholder')}
        aria-label={translate('feed.searchAria')}
        value={filters.search}
        onChange={(event) => update({ search: event.target.value })}
      />

      <div className="filter-toolbar" role="toolbar" aria-label={translate('feed.toolbarAria')}>
        <div className="filter-popover-anchor">
          <button
            ref={triggerRef}
            type="button"
            className="filter-toolbar-button"
            data-testid="filter-toolbar-button"
            aria-label={filterButtonLabel}
            aria-expanded={open}
            aria-haspopup="dialog"
            onClick={(event) => {
              event.stopPropagation();
              setOpen((visible) => !visible);
            }}
          >
            {translate('feed.filters')}
            {count > 0 && <span className="filter-count">{count}</span>}
          </button>
          {open && (
            <div
              ref={popoverRef}
              className="filter-popover"
              role="dialog"
              aria-label={translate('feed.filtersAria')}
            >
              <FilterSelect label={translate('feed.action')} value={filters.action ?? 'all'} onChange={(value) => update({ action: value === 'all' ? undefined : value as PopupEventFilters['action'] })}>
                <option value="all">{translate('feed.allActions')}</option>
                {ACTIONS.map((action) => <option key={action} value={action}>{translate(ACTION_LABEL_KEYS[action])}</option>)}
              </FilterSelect>
              <FilterSelect label={translate('feed.chain')} value={filters.chain ?? 'all'} onChange={(value) => update({ chain: value === 'all' ? undefined : value as PopupEventFilters['chain'] })}>
                <option value="all">{translate('feed.allChains')}</option>
                {CHAIN_KEYS.map((chain) => <option key={chain} value={chain}>{CHAIN_LABELS[chain]}</option>)}
              </FilterSelect>
              <FilterSelect label={translate('feed.trader')} value={filters.traderId ?? 'all'} onChange={(value) => update({ traderId: value === 'all' ? undefined : value })}>
                <option value="all">{translate('feed.allTraders')}</option>
                {traders.map((trader) => <option key={trader.traderId} value={trader.traderId}>@{trader.handle}</option>)}
              </FilterSelect>
              <FilterSelect label={translate('feed.token')} value={filters.tokenAddress ?? 'all'} onChange={(value) => update({ tokenAddress: value === 'all' ? undefined : value })}>
                <option value="all">{translate('feed.allTokens')}</option>
                {tokens.map((token) => <option key={token.address} value={token.address}>{token.symbol}</option>)}
              </FilterSelect>
            </div>
          )}
        </div>

        <button type="button" className="filter-toolbar-button" aria-pressed={filters.unreadOnly} onClick={() => update({ unreadOnly: !filters.unreadOnly })}>{translate('feed.unread')}</button>
        <button type="button" className="filter-toolbar-button" aria-pressed={pinnedFirst} onClick={() => onPinnedFirstChange(!pinnedFirst)}>{translate('feed.pinned')}</button>
        {hasResettableState && (
          <button
            type="button"
            className="filter-reset-button"
            data-testid="filter-reset-button"
            aria-label={translate('feed.resetFilters')}
            onClick={() => {
              onFiltersChange({ ...DEFAULT_FILTERS });
              onPinnedFirstChange(false);
              setOpen(false);
            }}
          >
            {translate('feed.reset')}
          </button>
        )}
      </div>

      <ActiveFilterChips filters={filters} traders={traders} tokens={tokens} onFiltersChange={onFiltersChange} />
    </div>
  );
}

function FilterSelect(props: {
  label: string;
  value: string;
  onChange(value: string): void;
  children: ReactNode;
}) {
  return (
    <label className="filter-select">
      <span>{props.label}</span>
      <select aria-label={props.label} value={props.value} onChange={(event) => props.onChange(event.target.value)}>
        {props.children}
      </select>
    </label>
  );
}
