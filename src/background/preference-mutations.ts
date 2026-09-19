import type { TraderAnnotationUpdate, TraderAnnotationV1 } from '../domain/annotations';
import type { LocalSettingsUpdate, LocalSettingsV6 } from '../domain/settings';
import type { LocalPreferencesStorage } from '../storage/local-preferences';

export const PREFERENCE_MUTATION_JOURNAL_KEY = 'preference-mutation-journal.v1';

const JOURNAL_VERSION = 1;
const MAX_RECEIPTS = 128;

export interface PreferenceMutationPreferences {
  updateSettings(update: LocalSettingsUpdate): Promise<LocalSettingsV6>;
  upsertAnnotation(
    traderId: string,
    update: TraderAnnotationUpdate,
    at: number,
  ): Promise<TraderAnnotationV1>;
  deleteAnnotation(traderId: string, at: number): Promise<TraderAnnotationV1>;
}

export type PreferenceMutation =
  | { mutationId: string; type: 'settings'; update: LocalSettingsUpdate }
  | {
    mutationId: string;
    type: 'annotation-upsert';
    traderId: string;
    update: TraderAnnotationUpdate;
    at: number;
  }
  | { mutationId: string; type: 'annotation-delete'; traderId: string; at: number };

export type PreferenceMutationResult =
  | { type: 'settings'; settings: LocalSettingsV6 }
  | { type: 'annotation'; annotation: TraderAnnotationV1 };

interface Receipt {
  mutationId: string;
  result: PreferenceMutationResult;
}

interface Journal {
  version: typeof JOURNAL_VERSION;
  pending?: PreferenceMutation;
  receipts: Receipt[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readJournal = (value: unknown): Journal => {
  if (!isRecord(value) || value.version !== JOURNAL_VERSION || !Array.isArray(value.receipts)) {
    return { version: JOURNAL_VERSION, receipts: [] };
  }

  return value as unknown as Journal;
};

/**
 * Serializes preference writes through a durable, bounded journal. A pending
 * mutation is replayed after worker restart; retries with the same ID receive
 * the original receipt instead of applying an absolute patch again.
 */
export class PreferenceMutationCoordinator {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly recovery: Promise<void>;

  constructor(private readonly options: {
    preferences: PreferenceMutationPreferences;
    storage: LocalPreferencesStorage;
  }) {
    this.recovery = this.recover();
  }

  ready(): Promise<void> {
    return this.recovery;
  }

  mutate(mutation: PreferenceMutation): Promise<PreferenceMutationResult> {
    const run = this.queue.then(async () => {
      await this.recovery;
      const journal = await this.loadJournal();
      const existing = journal.receipts.find((receipt) => receipt.mutationId === mutation.mutationId);

      if (existing !== undefined) {
        return existing.result;
      }

      await this.saveJournal({ ...journal, pending: mutation });
      const result = await this.apply(mutation);
      await this.saveJournal({
        version: JOURNAL_VERSION,
        receipts: [...journal.receipts, { mutationId: mutation.mutationId, result }].slice(-MAX_RECEIPTS),
      });

      return result;
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async recover(): Promise<void> {
    const journal = await this.loadJournal();

    if (journal.pending === undefined) {
      return;
    }

    const result = await this.apply(journal.pending);
    const receiptExists = journal.receipts.some(
      (receipt) => receipt.mutationId === journal.pending?.mutationId,
    );
    await this.saveJournal({
      version: JOURNAL_VERSION,
      receipts: receiptExists
        ? journal.receipts
        : [...journal.receipts, { mutationId: journal.pending.mutationId, result }].slice(-MAX_RECEIPTS),
    });
  }

  private async apply(mutation: PreferenceMutation): Promise<PreferenceMutationResult> {
    switch (mutation.type) {
      case 'settings':
        return { type: 'settings', settings: await this.options.preferences.updateSettings(mutation.update) };
      case 'annotation-upsert':
        return {
          type: 'annotation',
          annotation: await this.options.preferences.upsertAnnotation(
            mutation.traderId,
            mutation.update,
            mutation.at,
          ),
        };
      case 'annotation-delete':
        return {
          type: 'annotation',
          annotation: await this.options.preferences.deleteAnnotation(mutation.traderId, mutation.at),
        };
    }
  }

  private async loadJournal(): Promise<Journal> {
    const stored = await this.options.storage.get([PREFERENCE_MUTATION_JOURNAL_KEY]);
    return readJournal(stored[PREFERENCE_MUTATION_JOURNAL_KEY]);
  }

  private async saveJournal(journal: Journal): Promise<void> {
    await this.options.storage.set({ [PREFERENCE_MUTATION_JOURNAL_KEY]: journal });
  }
}
