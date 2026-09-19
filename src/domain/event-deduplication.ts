import type { ActivitySource, TradeEventV1 } from './activity';
import { getEventSources } from './activity';

/**
 * This compatibility helper intentionally accepts only source-scoped stable
 * identifiers. Similarity across platforms is not proof of identity: two
 * traders can buy the same token for the same amount in the same second.
 * EventRepository is the authoritative transactional deduplicator.
 */
export function isCrossSourceDuplicate(left: TradeEventV1, right: TradeEventV1): boolean {
  if (
    left.id === right.id
    || left.source !== right.source
    || left.networkId !== right.networkId
  ) return false;

  if (
    left.sourceTradeId !== undefined &&
    right.sourceTradeId !== undefined &&
    left.sourceTradeId === right.sourceTradeId
  ) {
    return true;
  }

  if (
    left.sourceEventId !== undefined &&
    right.sourceEventId !== undefined &&
    left.sourceEventId === right.sourceEventId
  ) {
    return true;
  }

  return false;
}

export function mergeEventSources(
  existing: TradeEventV1,
  incoming: TradeEventV1,
): TradeEventV1 | undefined {
  if (!isCrossSourceDuplicate(existing, incoming)) return undefined;
  const sources = [...new Set<ActivitySource>([
    ...getEventSources(existing),
    ...getEventSources(incoming),
  ])];

  return {
    ...existing,
    sources,
    ...(existing.traderName === undefined && incoming.traderName !== undefined
      ? { traderName: incoming.traderName }
      : {}),
    ...(existing.traderAvatarUrl === undefined && incoming.traderAvatarUrl !== undefined
      ? { traderAvatarUrl: incoming.traderAvatarUrl }
      : {}),
    ...(existing.tokenImageUrl === undefined && incoming.tokenImageUrl !== undefined
      ? { tokenImageUrl: incoming.tokenImageUrl }
      : {}),
    ...(existing.marketCap === undefined && incoming.marketCap !== undefined
      ? { marketCap: incoming.marketCap }
      : {}),
    ...(existing.price === undefined && incoming.price !== undefined
      ? { price: incoming.price }
      : {}),
    ...(existing.thesis === undefined && incoming.thesis !== undefined
      ? { thesis: incoming.thesis }
      : {}),
  };
}
