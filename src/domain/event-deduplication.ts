import type { ActivitySource, TradeEventV1 } from './activity';
import { getEventSources } from './activity';

const FALLBACK_WINDOW_MS = 2_000;

const normalizedHandle = (value: string): string =>
  value.trim().replace(/^@/u, '').toLocaleLowerCase('en-US');

const normalizedAddress = (value: string): string =>
  /^0x[0-9a-f]{40}$/iu.test(value) ? value.toLowerCase() : value;

const sourcesOverlap = (left: TradeEventV1, right: TradeEventV1): boolean => {
  const rightSources = new Set(getEventSources(right));
  return getEventSources(left).some((source) => rightSources.has(source));
};

/** Exact IDs may match capture channels; fuzzy matching stays cross-source only. */
export function isCrossSourceDuplicate(left: TradeEventV1, right: TradeEventV1): boolean {
  if (left.id === right.id || left.chain !== right.chain) return false;

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

  if (sourcesOverlap(left, right)) return false;

  return normalizedHandle(left.traderHandle) === normalizedHandle(right.traderHandle)
    && normalizedAddress(left.tokenAddress) === normalizedAddress(right.tokenAddress)
    && left.action === right.action
    && left.usdAmount !== undefined
    && right.usdAmount !== undefined
    && left.usdAmount === right.usdAmount
    && Math.abs(left.occurredAt - right.occurredAt) <= FALLBACK_WINDOW_MS;
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
