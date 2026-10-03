import { z } from 'zod';
import type { PopupEventFilters } from '../popup/event-query';

export const FEED_VIEW_STORAGE_KEY = 'feed.view.v1';

const amount = z.number().finite().nonnegative().optional();
const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  source: z.enum(['all', 'fomo', 'pump']),
  visibleActions: z.object({ buy: z.boolean(), sell: z.boolean(), thesis: z.boolean() }).strict(),
  minimumBuyAmount: amount,
  maximumBuyAmount: amount,
  minimumMarketCap: amount,
  maximumMarketCap: amount,
}).strict();

export type FeedViewSnapshot = Omit<z.infer<typeof snapshotSchema>, 'schemaVersion'>;

interface SessionStorage {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** Session-only view state shared by surfaces, independent of durable preferences. */
export class FeedViewStore {
  private pending: Promise<void> = Promise.resolve();

  constructor(private readonly storage: SessionStorage) {}

  async load(): Promise<FeedViewSnapshot | undefined> {
    await this.flush();
    const record = await this.storage.get(FEED_VIEW_STORAGE_KEY);
    const parsed = snapshotSchema.safeParse(record[FEED_VIEW_STORAGE_KEY]);
    if (!parsed.success) return undefined;
    const { schemaVersion: _, ...snapshot } = parsed.data;
    return snapshot;
  }

  save(filters: PopupEventFilters): Promise<void> {
    const snapshot = snapshotSchema.parse({
      schemaVersion: 1,
      source: filters.source,
      visibleActions: { ...filters.visibleActions },
      minimumBuyAmount: filters.minimumBuyAmount,
      maximumBuyAmount: filters.maximumBuyAmount,
      minimumMarketCap: filters.minimumMarketCap,
      maximumMarketCap: filters.maximumMarketCap,
    });
    // Keep the queue usable after a failure, but leave flush rejecting until
    // a subsequent user write actually succeeds. A failed handoff must not reset filters.
    this.pending = this.pending.catch(() => {}).then(() => this.storage.set({ [FEED_VIEW_STORAGE_KEY]: snapshot }));
    return this.pending;
  }

  flush(): Promise<void> {
    return this.pending;
  }
}
