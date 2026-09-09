import { useLocale } from '../i18n/LocaleProvider';
import { ACTION_LABEL_KEYS } from '../overlay/presentation';
import {
  DEFAULT_VISIBLE_ACTIONS,
  type FilterableAction,
  type PopupEventFilters,
} from '../popup/event-query';
import { SourceIcon } from './SourceIcon';

const ACTIONS: readonly FilterableAction[] = ['buy', 'sell', 'thesis'];

export interface QuickFeedFiltersProps {
  filters: PopupEventFilters;
  onFiltersChange(filters: PopupEventFilters): void;
}

export function QuickFeedFilters({ filters, onFiltersChange }: QuickFeedFiltersProps) {
  const { translate } = useLocale();
  const allActionsVisible = ACTIONS.every((action) => filters.visibleActions[action]);

  return (
    <nav className="quick-feed-filters" aria-label={translate('feed.quickFiltersAria')}>
      <div className="quick-filter-group" role="group" aria-label={translate('feed.quickActionFilters')}>
        <button
          type="button"
          className="quick-filter-chip"
          aria-pressed={allActionsVisible}
          onClick={() => onFiltersChange({
            ...filters,
            visibleActions: { ...DEFAULT_VISIBLE_ACTIONS },
          })}
        >
          {translate('feed.allActions')}
        </button>
        {ACTIONS.map((action) => (
          <button
            key={action}
            type="button"
            className={`quick-filter-chip quick-filter-action quick-filter-action-${action}`}
            aria-pressed={filters.visibleActions[action]}
            onClick={() => onFiltersChange({
              ...filters,
              visibleActions: {
                ...filters.visibleActions,
                [action]: !filters.visibleActions[action],
              },
            })}
          >
            {translate(ACTION_LABEL_KEYS[action])}
          </button>
        ))}
      </div>

      <span className="quick-filter-divider" aria-hidden="true" />

      <div className="quick-filter-group" role="group" aria-label={translate('feed.quickSourceFilters')}>
        {(['all', 'fomo', 'pump'] as const).map((source) => (
          <button
            key={source}
            type="button"
            className="quick-filter-chip quick-filter-source"
            aria-pressed={filters.source === source}
            onClick={() => onFiltersChange({ ...filters, source })}
          >
            {source !== 'all' && <SourceIcon source={source} />}
            {source === 'all' ? translate('feed.allSources') : source === 'fomo' ? 'Fomo' : 'Pump'}
          </button>
        ))}
      </div>
    </nav>
  );
}
