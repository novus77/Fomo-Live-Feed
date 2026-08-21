import type { TradeEventV1 } from '../domain/activity';
import type { TraderAnnotationUpdate, TraderAnnotationV1 } from '../domain/annotations';
import type { LocalSettingsV2 } from '../domain/settings';
import { useLocale } from '../i18n/LocaleProvider';
import type { BrowserTranslationApi } from '../translation/browser-translation';
import type { OpinionTranslationCoordinator } from '../translation/opinion-translation';
import { EventCard } from '../sidepanel/EventCard';

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
  settings: LocalSettingsV2;
  annotations: ReadonlyMap<string, TraderAnnotationV1>;
  now: () => number;
  copyText: (text: string) => Promise<void>;
  openLink: (url: URL) => void;
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
  onLoadMore(): void;
  onRetry(): void;
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
    settings,
    annotations,
    now,
    copyText,
    openLink,
    translationApi,
    translationCoordinator,
    onLoadMore,
    onRetry,
    onUpsertAnnotation,
    onDeleteAnnotation,
  } = props;
  const { translate } = useLocale();

  if (status === 'loading') {
    return <p className="feed-loading">{translate('feed.loading')}</p>;
  }

  if (status === 'error') {
    return (
      <div className="feed-error" role="alert">
        <p className="feed-error-message">{translate('feed.error')}</p>
        <button type="button" className="feed-retry" onClick={onRetry}>
          {translate('feed.retry')}
        </button>
      </div>
    );
  }

  if (events.length === 0) {
    return <p className="feed-empty">{translate('feed.empty')}</p>;
  }

  return (
    <div className="feed" data-testid="history-feed">
      {scanExceeded && (
        <p className="feed-scan-hint" role="status">
          {translate('feed.scanExceeded')}
        </p>
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
              openLink={openLink}
              {...(translationApi !== undefined ? { translationApi } : {})}
              {...(translationCoordinator !== undefined
                ? { translationCoordinator }
                : {})}
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
