import type { TradeEventV1 } from '../domain/activity';

/**
 * Applies a newer head-page to an already loaded feed window without
 * discarding the history pages the user explicitly requested.
 *
 * The event ID is the persisted canonical identity. A fresh database row wins
 * for all persisted fields, while a locally acknowledged `readAt` is retained
 * until the database snapshot catches up.
 */
export function reconcileLiveFeedWindow(
  loaded: readonly TradeEventV1[],
  incomingHead: readonly TradeEventV1[],
): TradeEventV1[] {
  const byId = new Map<string, TradeEventV1>();

  for (const event of loaded) {
    byId.set(event.id, event);
  }

  for (const incoming of incomingHead) {
    const existing = byId.get(incoming.id);
    byId.set(
      incoming.id,
      existing?.readAt !== undefined && incoming.readAt === undefined
        ? { ...incoming, readAt: existing.readAt }
        : incoming,
    );
  }

  return Array.from(byId.values()).sort(
    (left, right) => right.occurredAt - left.occurredAt || right.id.localeCompare(left.id),
  );
}
