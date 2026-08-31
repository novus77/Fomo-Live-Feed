import { useEffect, useRef, useState } from 'react';

import { useLocale } from '../i18n/LocaleProvider';
import { ACTION_LABEL_KEYS } from '../overlay/presentation';
import {
  DEFAULT_FILTERS,
  DEFAULT_VISIBLE_ACTIONS,
  activeSidePanelFilterGroupCount,
  type FilterableAction,
  type PopupEventFilters,
} from '../popup/event-query';
import { parseMarketCapRange } from './market-cap-range';
import { ChainVisibilityFilter } from './ChainVisibilityFilter';
import { FILTERABLE_CHAINS } from './chain-visibility';

const FILTERABLE_ACTIONS: readonly FilterableAction[] = ['buy', 'sell', 'thesis'];

export interface FeedFilterPopoverProps {
  filters: PopupEventFilters;
  open: boolean;
  onOpenChange(open: boolean): void;
  onFiltersChange(filters: PopupEventFilters): void;
}

const toKDraft = (marketCap: number | undefined): string => (
  marketCap === undefined ? '' : String(marketCap / 1_000)
);

export function FeedFilterPopover(props: FeedFilterPopoverProps) {
  const { filters, open, onOpenChange, onFiltersChange } = props;
  const { translate } = useLocale();
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [minimumDraft, setMinimumDraft] = useState(() => toKDraft(filters.minimumMarketCap));
  const [maximumDraft, setMaximumDraft] = useState(() => toKDraft(filters.maximumMarketCap));
  const [rangeError, setRangeError] = useState<'invalid-number' | 'reversed-range'>();

  useEffect(() => {
    setMinimumDraft(toKDraft(filters.minimumMarketCap));
    setMaximumDraft(toKDraft(filters.maximumMarketCap));
  }, [filters.minimumMarketCap, filters.maximumMarketCap]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handlePointerDown = (event: MouseEvent): void => {
      if (!anchorRef.current?.contains(event.target as Node)) {
        onOpenChange(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onOpenChange(false);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onOpenChange, open]);

  const applyRangeDraft = (nextMinimum: string, nextMaximum: string): void => {
    const parsed = parseMarketCapRange(nextMinimum, nextMaximum);

    if (!parsed.ok) {
      setRangeError(parsed.reason);
      return;
    }

    setRangeError(undefined);
    onFiltersChange({
      ...filters,
      minimumMarketCap: parsed.minimum,
      maximumMarketCap: parsed.maximum,
    });
  };

  const activeGroups = activeSidePanelFilterGroupCount(filters);

  return (
    <div className="sidepanel-filter-anchor" ref={anchorRef}>
      <button
        ref={triggerRef}
        type="button"
        className="sidepanel-filter-toggle"
        aria-label={translate('feed.filters')}
        title={translate('feed.filters')}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => onOpenChange(!open)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path fill="currentColor" d="M3 5h18l-7 8v5.2l-4 2V13L3 5Z" />
        </svg>
        {activeGroups > 0 && <span className="sidepanel-filter-count">{activeGroups}</span>}
      </button>

      {open && (
        <section className="feed-filter-popover" role="dialog" aria-label={translate('feed.filterDialog')}>
          <div className="feed-filter-section">
            <span className="feed-filter-label">{translate('feed.filterActions')}</span>
            <div className="feed-filter-actions">
              {FILTERABLE_ACTIONS.map((action) => {
                const selected = filters.visibleActions[action];

                return (
                  <button
                    key={action}
                    type="button"
                    className="feed-filter-action"
                    aria-pressed={selected}
                    onClick={() => {
                      onFiltersChange({
                        ...filters,
                        visibleActions: {
                          ...filters.visibleActions,
                          [action]: !selected,
                        },
                      });
                    }}
                  >
                    <span aria-hidden="true" className="feed-filter-check">{selected ? '✓' : ''}</span>
                    {translate(ACTION_LABEL_KEYS[action])}
                  </button>
                );
              })}
            </div>
          </div>

          <ChainVisibilityFilter
            visibleChains={filters.visibleChains}
            onChange={(visibleChains) => onFiltersChange({ ...filters, visibleChains })}
          />

          <div className="feed-filter-section">
            <span className="feed-filter-label">{translate('feed.filterMarketCap')}</span>
            <div className="feed-filter-range">
              <label className="feed-filter-range-input">
                <span className="visually-hidden">{translate('feed.filterMarketCapMinimum')}</span>
                <input
                  value={minimumDraft}
                  inputMode="decimal"
                  placeholder="Min"
                  aria-label={translate('feed.filterMarketCapMinimum')}
                  onChange={(event) => {
                    const nextMinimum = event.target.value;
                    setMinimumDraft(nextMinimum);
                    applyRangeDraft(nextMinimum, maximumDraft);
                  }}
                />
                <span aria-hidden="true">K</span>
              </label>
              <span className="feed-filter-range-to" aria-hidden="true">to</span>
              <label className="feed-filter-range-input">
                <span className="visually-hidden">{translate('feed.filterMarketCapMaximum')}</span>
                <input
                  value={maximumDraft}
                  inputMode="decimal"
                  placeholder="Max"
                  aria-label={translate('feed.filterMarketCapMaximum')}
                  onChange={(event) => {
                    const nextMaximum = event.target.value;
                    setMaximumDraft(nextMaximum);
                    applyRangeDraft(minimumDraft, nextMaximum);
                  }}
                />
                <span aria-hidden="true">K</span>
              </label>
            </div>
            {rangeError !== undefined && (
              <p className="feed-filter-error" role="alert">
                {translate(rangeError === 'reversed-range'
                  ? 'feed.filterReversedRange'
                  : 'feed.filterInvalidRange')}
              </p>
            )}
          </div>

          <button
            type="button"
            className="feed-filter-reset"
            onClick={() => {
              setMinimumDraft('');
              setMaximumDraft('');
              setRangeError(undefined);
              onFiltersChange({
                ...DEFAULT_FILTERS,
                visibleActions: { ...DEFAULT_VISIBLE_ACTIONS },
                visibleChains: [...FILTERABLE_CHAINS],
              });
            }}
          >
            {translate('feed.resetFilters')}
          </button>
        </section>
      )}
    </div>
  );
}
