import type { TradeEventV1 } from '../domain/activity';
import type { TraderAnnotationUpdate, TraderAnnotationV1 } from '../domain/annotations';
import type { LocalSettingsV1 } from '../domain/settings';
import { EventCard } from './EventCard';

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
 */
export interface HistoryFeedProps {
  events: readonly TradeEventV1[];
  status: 'loading' | 'ready' | 'error';
  hasMore: boolean;
  loadingMore: boolean;
  /** True when the sparse-search scan cap was hit (SHOULD-FIX 4). */
  scanExceeded: boolean;
  settings: LocalSettingsV1;
  annotations: ReadonlyMap<string, TraderAnnotationV1>;
  now: () => number;
  copyText: (text: string) => Promise<void>;
  openLink: (url: URL) => void;
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
    onLoadMore,
    onRetry,
    onUpsertAnnotation,
    onDeleteAnnotation,
  } = props;

  if (status === 'loading') {
    return <p className="feed-loading">Loading history…</p>;
  }

  if (status === 'error') {
    return (
      <div className="feed-error" role="alert">
        <p className="feed-error-message">
          History could not be loaded right now.
        </p>
        <button type="button" className="feed-retry" onClick={onRetry}>
          Try again
        </button>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <p className="feed-empty">
        No activity yet - trades from traders you follow will appear here.
      </p>
    );
  }

  return (
    <div className="feed" data-testid="history-feed">
      {scanExceeded && (
        <p className="feed-scan-hint" role="status">
          Your search matches very few rows. Narrow your search (more of the
          trader name, token symbol, or address) to see earlier matches.
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
          {loadingMore ? 'Loading more…' : 'Load more'}
        </button>
      )}
    </div>
  );
}
