import { useEffect, useId, useRef, useState } from 'react';

import { useLocale } from '../i18n/LocaleProvider';
import { ACTION_LABEL_KEYS } from '../overlay/presentation';
import {
  DEFAULT_FILTERS,
  DEFAULT_VISIBLE_ACTIONS,
  activeSidePanelFilterGroupCount,
  type FilterableAction,
  type PopupEventFilters,
} from '../popup/event-query';
import { parseBuyAmountRange } from './buy-amount-range';
import { parseMarketCapRange } from './market-cap-range';
import { ChainVisibilityFilter } from './ChainVisibilityFilter';
import { FILTERABLE_CHAINS } from './chain-visibility';
import { SourceIcon } from './SourceIcon';

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

const toUsdDraft = (amount: number | undefined): string => (
  amount === undefined ? '' : String(amount)
);

export function FeedFilterPopover(props: FeedFilterPopoverProps) {
  const { filters, open, onOpenChange, onFiltersChange } = props;
  const { locale, translate } = useLocale();
  const anchorRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const [minimumDraft, setMinimumDraft] = useState(() => toKDraft(filters.minimumMarketCap));
  const [maximumDraft, setMaximumDraft] = useState(() => toKDraft(filters.maximumMarketCap));
  const [rangeError, setRangeError] = useState<'invalid-number' | 'reversed-range'>();
  const [minimumBuyDraft, setMinimumBuyDraft] = useState(
    () => toUsdDraft(filters.minimumBuyAmount),
  );
  const [maximumBuyDraft, setMaximumBuyDraft] = useState(
    () => toUsdDraft(filters.maximumBuyAmount),
  );
  const [buyRangeError, setBuyRangeError] = useState<'invalid-number' | 'reversed-range'>();

  useEffect(() => {
    setMinimumDraft(toKDraft(filters.minimumMarketCap));
    setMaximumDraft(toKDraft(filters.maximumMarketCap));
    if (!open) setRangeError(undefined);
  }, [filters.minimumMarketCap, filters.maximumMarketCap, open]);

  useEffect(() => {
    setMinimumBuyDraft(toUsdDraft(filters.minimumBuyAmount));
    setMaximumBuyDraft(toUsdDraft(filters.maximumBuyAmount));
    if (!open) setBuyRangeError(undefined);
  }, [filters.minimumBuyAmount, filters.maximumBuyAmount, open]);

  useEffect(() => {
    if (open) {
      anchorRef.current
        ?.querySelector<HTMLButtonElement>('.feed-filter-popover button:not(:disabled)')
        ?.focus();
    }
  }, [open]);

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

  const applyBuyRangeDraft = (nextMinimum: string, nextMaximum: string): void => {
    const parsed = parseBuyAmountRange(nextMinimum, nextMaximum);

    if (!parsed.ok) {
      setBuyRangeError(parsed.reason);
      return;
    }

    setBuyRangeError(undefined);
    onFiltersChange({
      ...filters,
      minimumBuyAmount: parsed.minimum,
      maximumBuyAmount: parsed.maximum,
    });
  };

  const activeGroups = activeSidePanelFilterGroupCount(filters);
  const hiddenActions = FILTERABLE_ACTIONS.filter((action) => !filters.visibleActions[action]);
  const summaryParts: string[] = [];
  if (filters.source !== 'all') {
    summaryParts.push(translate('feed.filterSummarySource', {
      source: filters.source === 'fomo' ? 'Fomo' : 'Pump',
    }));
  }
  if (hiddenActions.length > 0) {
    summaryParts.push(translate('feed.filterSummaryActions', {
      actions: hiddenActions
        .map((action) => translate(ACTION_LABEL_KEYS[action]))
        .join(locale === 'zh-CN' ? '、' : ', '),
    }));
  }
  if (filters.visibleChains.length !== FILTERABLE_CHAINS.length) {
    summaryParts.push(translate('feed.filterSummaryChains', {
      chains: filters.visibleChains.length,
      total: FILTERABLE_CHAINS.length,
    }));
  }
  if (filters.minimumBuyAmount !== undefined || filters.maximumBuyAmount !== undefined) {
    const minimum = filters.minimumBuyAmount === undefined
      ? undefined
      : `$${filters.minimumBuyAmount}`;
    const maximum = filters.maximumBuyAmount === undefined
      ? undefined
      : `$${filters.maximumBuyAmount}`;
    const range = minimum !== undefined && maximum !== undefined
      ? `${minimum}–${maximum}`
      : minimum !== undefined
        ? `≥ ${minimum}`
        : `≤ ${maximum}`;
    summaryParts.push(translate('feed.filterSummaryBuyAmount', { range }));
  }
  if (filters.minimumMarketCap !== undefined || filters.maximumMarketCap !== undefined) {
    const minimum = filters.minimumMarketCap === undefined
      ? undefined
      : `${filters.minimumMarketCap / 1_000}K`;
    const maximum = filters.maximumMarketCap === undefined
      ? undefined
      : `${filters.maximumMarketCap / 1_000}K`;
    const range = minimum !== undefined && maximum !== undefined
      ? `${minimum}–${maximum}`
      : minimum !== undefined
        ? `≥ ${minimum}`
        : `≤ ${maximum}`;
    summaryParts.push(translate('feed.filterSummaryMarketCap', { range }));
  }
  const filterTitle = activeGroups > 0
    ? translate('feed.filterSummary', {
      count: activeGroups,
      details: summaryParts.join(' · '),
    })
    : translate('feed.filters');

  return (
    <div className="sidepanel-filter-anchor" ref={anchorRef}>
      <button
        ref={triggerRef}
        type="button"
        className="sidepanel-filter-toggle compact-icon-button"
        aria-label={filterTitle}
        title={filterTitle}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls={popoverId}
        onClick={() => onOpenChange(!open)}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path fill="currentColor" d="M3 5h18l-7 8v5.2l-4 2V13L3 5Z" />
        </svg>
        {activeGroups > 0 && (
          <span className="sidepanel-filter-count" aria-hidden="true">{activeGroups}</span>
        )}
      </button>

      {open && (
        <section
          id={popoverId}
          className="feed-filter-popover"
          role="dialog"
          aria-label={translate('feed.filterDialog')}
        >
          <div className="feed-filter-section">
            <span className="feed-filter-label">{translate('feed.filterSources')}</span>
            <div className="feed-filter-actions" role="group" aria-label={translate('feed.filterSources')}>
              {(['all', 'fomo', 'pump'] as const).map((source) => {
                const selected = filters.source === source;
                const label = source === 'all'
                  ? translate('feed.allSources')
                  : source === 'fomo' ? 'Fomo' : 'Pump';
                return (
                  <button
                    key={source}
                    type="button"
                    className="feed-filter-action feed-filter-source"
                    aria-pressed={selected}
                    onClick={() => onFiltersChange({ ...filters, source })}
                  >
                    {source !== 'all' && <SourceIcon source={source} />}
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="feed-filter-section">
            <span className="feed-filter-label">{translate('feed.filterActions')}</span>
            <div className="feed-filter-actions">
              {FILTERABLE_ACTIONS.map((action) => {
                const selected = filters.visibleActions[action];

                return (
                  <button
                    key={action}
                    type="button"
                    className={`feed-filter-action feed-filter-action-${action}`}
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
            <span className="feed-filter-label">{translate('feed.filterBuyAmount')}</span>
            <div className="feed-filter-range">
              <label className="feed-filter-range-input">
                <span className="visually-hidden">{translate('feed.filterBuyAmountMinimum')}</span>
                <input
                  value={minimumBuyDraft}
                  inputMode="decimal"
                  placeholder="Min"
                  aria-label={translate('feed.filterBuyAmountMinimum')}
                  onChange={(event) => setMinimumBuyDraft(event.target.value)}
                  onBlur={() => applyBuyRangeDraft(minimumBuyDraft, maximumBuyDraft)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      applyBuyRangeDraft(minimumBuyDraft, maximumBuyDraft);
                    }
                  }}
                />
                <span aria-hidden="true">$</span>
              </label>
              <span className="feed-filter-range-to" aria-hidden="true">to</span>
              <label className="feed-filter-range-input">
                <span className="visually-hidden">{translate('feed.filterBuyAmountMaximum')}</span>
                <input
                  value={maximumBuyDraft}
                  inputMode="decimal"
                  placeholder="Max"
                  aria-label={translate('feed.filterBuyAmountMaximum')}
                  onChange={(event) => setMaximumBuyDraft(event.target.value)}
                  onBlur={() => applyBuyRangeDraft(minimumBuyDraft, maximumBuyDraft)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      applyBuyRangeDraft(minimumBuyDraft, maximumBuyDraft);
                    }
                  }}
                />
                <span aria-hidden="true">$</span>
              </label>
            </div>
            {buyRangeError !== undefined && (
              <p className="feed-filter-error" role="alert">
                {translate(buyRangeError === 'reversed-range'
                  ? 'feed.filterBuyAmountReversed'
                  : 'feed.filterBuyAmountInvalid')}
              </p>
            )}
          </div>

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
                  }}
                  onBlur={() => applyRangeDraft(minimumDraft, maximumDraft)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') applyRangeDraft(minimumDraft, maximumDraft);
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
                  }}
                  onBlur={() => applyRangeDraft(minimumDraft, maximumDraft)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') applyRangeDraft(minimumDraft, maximumDraft);
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
              setMinimumBuyDraft('');
              setMaximumBuyDraft('');
              setBuyRangeError(undefined);
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
