import {
  getEventSources,
  type ActivitySource,
  type TradeEventV1,
} from '../domain/activity';

export interface SourceReadHealth {
  /** The currently mounted surface owns read-state updates. */
  ownsRead: boolean;
  fomoLive: boolean;
  pumpLive: boolean;
}

/**
 * Decides read eligibility for one rendered event. A merged event is only
 * eligible through a source that is both visible under the current filter and
 * live in this surface; another source's cached history must stay unread.
 */
export function canMarkEventRead(
  event: TradeEventV1,
  sourceFilter: ActivitySource | 'all',
  health: SourceReadHealth,
): boolean {
  if (!health.ownsRead) {
    return false;
  }

  const visibleSources = getEventSources(event).filter(
    (source) => sourceFilter === 'all' || source === sourceFilter,
  );

  return visibleSources.some((source) =>
    source === 'fomo' ? health.fomoLive : health.pumpLive,
  );
}
