import type { PersistedPipelineHealth, PipelineHealthEvent } from './pipeline-health';

interface IngestionBatchEffectsOptions {
  health: Pick<PersistedPipelineHealth, 'record' | 'flush'>;
  notifyEvents(): Promise<void>;
  notifyHealth(): void;
}

/** Batch-local observability and invalidation; never owns event persistence. */
export class IngestionBatchEffects {
  private healthChanged = false;
  private eventsChanged = false;
  private flushing: Promise<void> | null = null;

  constructor(private readonly options: IngestionBatchEffectsOptions) {}

  async record(event: PipelineHealthEvent): Promise<void> {
    await this.options.health.record(event, { deferPersistence: true });
    this.healthChanged = true;
  }

  invalidateEvents(): void {
    this.eventsChanged = true;
  }

  flush(): Promise<void> {
    if (this.flushing === null) {
      // Assign ownership before drain can finish an empty batch synchronously.
      this.flushing = Promise.resolve().then(() => this.drain());
    }
    return this.flushing;
  }

  private async drain(): Promise<void> {
    try {
      while (this.healthChanged || this.eventsChanged) {
        const healthChanged = this.healthChanged;
        const eventsChanged = this.eventsChanged;
        this.healthChanged = false;
        this.eventsChanged = false;
        let failure: { error: unknown } | undefined;

        if (healthChanged) {
          try {
            await this.options.health.flush();
            this.options.notifyHealth();
          } catch (error) {
            this.healthChanged = true;
            failure = { error };
          }
        }
        if (eventsChanged) {
          try {
            await this.options.notifyEvents();
          } catch (error) {
            this.eventsChanged = true;
            failure ??= { error };
          }
        }
        // Both independent tails are attempted, but failure is retried only at
        // another explicit boundary, never in a tight loop.
        if (failure !== undefined) throw failure.error;
      }
    } finally {
      // Release before the async promise settles; a later microtask must not
      // attach new dirty work to an already-drained owner.
      this.flushing = null;
    }
  }
}
