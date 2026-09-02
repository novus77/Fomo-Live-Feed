import type { TradeEventV1 } from '../domain/activity';
import type { TraderAnnotationUpdate, TraderAnnotationV1 } from '../domain/annotations';
import type { LocalSettingsV5 } from '../domain/settings';
import { useLocale } from '../i18n/LocaleProvider';
import type { BrowserTranslationApi } from '../translation/browser-translation';
import type { OpinionTranslationCoordinator } from '../translation/opinion-translation';
import { EventCard } from '../sidepanel/EventCard';
import { FeedSkeleton, FeedState } from '../sidepanel/FeedState';

/**
 * History feed (plan Task 9 Step 3, spec sections 4.5 and 7.3).
 *
 * Renders the connected-with-history state and its empty sibling. The feed
 * is presentational: the App owns the useEventFeed hook and passes the
 * already-filtered, already-sorted rows plus the pagination callbacks.
 *
 * Three non-history statuses render here too:
 * - loading: the first page is being fetched;
 * - error: the FIRST page fetch failed (worker suspended, storage error) -
 *   the user gets a retry affordance instead of the misleading empty-state
 *   message (NIT); a failed reload keeps the previous rows so this state is
 *   only reachable when nothing was ever shown;
 * - scanExceeded: the bounded page scan (SHOULD-FIX 4) could not fill the
 *   display limit because the search matches too sparsely - surface a
 *   "narrow your search" notice.
 * Full/filter reload failures intentionally replace the feed with this error
 * state so pagination from the previous filter cannot remain actionable.
 */
export interface HistoryFeedProps {
  events: readonly TradeEventV1[];
  status: 'loading' | 'ready' | 'error';
  hasMore: boolean;
  loadingMore: boolean;
  /** True when the sparse-search scan cap was hit (SHOULD-FIX 4). */
  scanExceeded: boolean;
  noChainsSelected: boolean;
  settings: LocalSettingsV5;
  annotations: ReadonlyMap<string, TraderAnnotationV1>;
  now: () => number;
  copyText: (text: string) => Promise<void>;
  openLink: (url: URL) => void;
  onOpenToken?: (target: Pick<TradeEventV1, 'chain' | 'tokenAddress'>) => void;
  /**
   * The side panel's shared on-device translation adapter (plan Task 7),
   * forwarded to every thesis card. Optional for the legacy popup harness;
   * EventCard falls back to creating its own adapter.
   */
  translationApi?: BrowserTranslationApi;
  /**
   * The side panel's shared on-device translation coordinator (ONE per
   * panel, plan Task 7), forwarded to every thesis card so all cards share a
   * single session cache / live-session pool.
   */
  translationCoordinator?: OpinionTranslationCoordinator;
  translationRetryToken?: number;
  onLoadMore(): void;
  onRetry(): void;
  onSelectAllChains(): void;
  onUpsertAnnotation(traderId: string, update: TraderAnnotationUpdate): void;
  onDeleteAnnotation(traderId: string): void;
}

export function HistoryFeed(props: HistoryFeedProps) {
  const {
    events,
    status,
    hasMore,
    loadingMore,
    scanExceeded,
    noChainsSelected,
    settings,
    annotations,
    now,
    copyText,
    onOpenToken,
    translationApi,
    translationCoordinator,
    translationRetryToken,
    onLoadMore,
    onRetry,
    onSelectAllChains,
    onUpsertAnnotation,
    onDeleteAnnotation,
  } = props;
  const { translate } = useLocale();

  if (status === 'loading') {
    return <FeedSkeleton rows={3} loadingLabel={translate('feed.loading')} />;
  }

  if (status === 'error') {
    return (
      <FeedState
        tone="error"
        message={translate('feed.error')}
        actionLabel={translate('feed.retry')}
        onAction={onRetry}
      />
    );
  }

  if (noChainsSelected) {
    return (
      <FeedState
        tone="empty"
        message={translate('feed.noChainsSelected')}
        actionLabel={translate('feed.selectAllChains')}
        onAction={onSelectAllChains}
      />
    );
  }

  if (events.length === 0) {
    return <FeedState tone="empty" message={translate('feed.empty')} />;
  }

  return (
    <div className="feed" data-testid="history-feed">
      {scanExceeded && (
        <FeedState tone="info" message={translate('feed.scanExceeded')} />
      )}
      <ul className="feed-list">
        {events.map((event) => (
          <li key={event.id} className="feed-item">
            <EventCard
              event={event}
              settings={settings}
              annotation={annotations.get(event.traderId)}
              now={now}
              copyText={copyText}
              onOpenToken={onOpenToken ?? (() => {})}
              {...(translationApi !== undefined ? { translationApi } : {})}
              {...(translationCoordinator !== undefined
                ? { translationCoordinator }
                : {})}
              {...(translationRetryToken === undefined
                ? {}
                : { translationRetryToken })}
              onUpsertAnnotation={onUpsertAnnotation}
              onDeleteAnnotation={onDeleteAnnotation}
            />
          </li>
        ))}
      </ul>
      {hasMore && (
        <button
          type="button"
          className="feed-load-more"
          disabled={loadingMore}
          onClick={onLoadMore}
        >
          {loadingMore ? translate('feed.loadingMore') : translate('feed.loadMore')}
        </button>
      )}
    </div>
  );
}
