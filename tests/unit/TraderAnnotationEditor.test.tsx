import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TradeEventV1 } from '../../src/domain/activity';
import {
  ANNOTATION_COLORS,
  MAX_ANNOTATION_LABEL_LENGTH,
} from '../../src/domain/annotations';
import { DEFAULT_SETTINGS } from '../../src/domain/settings';
import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import { parseExtensionMessage } from '../../src/messaging/protocol';
import { PopupApp, type PopupDependencies } from '../../src/popup/PopupApp';
import {
  TraderAnnotationEditor,
  parseEditorLabel,
} from '../../src/popup/TraderAnnotationEditor';
import type { PopupRuntimeLike } from '../../src/popup/popup-io';
import type { EventPageQuery } from '../../src/storage/event-repository';
import { FomoFeedDatabase } from '../../src/storage/database';
import { EventRepository } from '../../src/storage/event-repository';
import {
  ANNOTATIONS_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  type LocalPreferencesStorage,
} from '../../src/storage/local-preferences';

// Editor strings render through useLocale (EN catalog here); the real
// provider behavior is covered by LocaleProvider.test.tsx.
vi.mock('../../src/i18n/LocaleProvider', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/i18n/LocaleProvider')>();
  const { translate: translateMessage } = await import('../../src/i18n/catalog');

  const useLocale = (): LocaleContextValue => ({
    locale: 'en',
    setLocale: () => {},
    translate: (key, values) => translateMessage('en', key, values),
  });

  return { ...actual, useLocale };
});

const NOW = 1_800_000_000_000;
const TOKEN_ADDRESS = '0x020bfc650a365f8bb26819deaabf3e21291018b4';

function makeEvent(overrides: Partial<TradeEventV1> = {}): TradeEventV1 {
  return {
    schemaVersion: 1,
    id: 'fomo:event-1',
    source: 'fomo',
    traderId: 'trader-1',
    traderHandle: 'alpha',
    traderName: 'Alpha Whale',
    chain: 'bsc',
    tokenAddress: TOKEN_ADDRESS,
    tokenSymbol: 'FOMO',
    action: 'buy',
    occurredAt: NOW - 60_000,
    receivedAt: NOW,
    ...overrides,
  };
}

describe('parseEditorLabel', () => {
  it('trims the label', () => {
    expect(parseEditorLabel('  Whale  ')).toEqual({ ok: true, label: 'Whale' });
  });

  it('clears the label with an empty or whitespace-only input', () => {
    expect(parseEditorLabel('')).toEqual({ ok: true, label: '' });
    expect(parseEditorLabel('   ')).toEqual({ ok: true, label: '' });
  });

  it('rejects labels longer than the annotation limit', () => {
    const result = parseEditorLabel('x'.repeat(MAX_ANNOTATION_LABEL_LENGTH + 1));

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining(String(MAX_ANNOTATION_LABEL_LENGTH)),
    });
  });

  it('accepts a label of exactly the maximum length', () => {
    expect(parseEditorLabel('x'.repeat(MAX_ANNOTATION_LABEL_LENGTH))).toEqual({
      ok: true,
      label: 'x'.repeat(MAX_ANNOTATION_LABEL_LENGTH),
    });
  });
});

type EditorProps = ComponentProps<typeof TraderAnnotationEditor>;

function renderEditor(props: Partial<EditorProps> = {}) {
  const callbacks = {
    onSaveLabel: vi.fn(),
    onSelectColor: vi.fn(),
    onTogglePin: vi.fn(),
    onToggleMute: vi.fn(),
    onDelete: vi.fn(),
  };

  const utils = render(
    <TraderAnnotationEditor annotation={undefined} {...callbacks} {...props} />,
  );

  return { ...utils, ...callbacks };
}

describe('TraderAnnotationEditor', () => {
  it('renders the label input, every color swatch, and the pin/mute/delete controls', () => {
    renderEditor();

    expect(screen.getByRole('textbox', { name: /label/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /save label/i })).toBeInTheDocument();

    for (const color of ANNOTATION_COLORS) {
      expect(screen.getByRole('button', { name: 'Color ' + color })).toBeInTheDocument();
    }

    expect(screen.getByRole('button', { name: /pin trader/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /mute trader/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /remove label/i })).toBeInTheDocument();
  });

  it('saves a trimmed label', () => {
    const { onSaveLabel } = renderEditor();

    fireEvent.change(screen.getByRole('textbox', { name: /label/i }), {
      target: { value: '  Whale Watch  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save label/i }));

    expect(onSaveLabel).toHaveBeenCalledWith('Whale Watch');
  });

  it('rejects an over-length label and shows an error instead of saving', () => {
    const { onSaveLabel } = renderEditor();

    fireEvent.change(screen.getByRole('textbox', { name: /label/i }), {
      target: { value: 'x'.repeat(MAX_ANNOTATION_LABEL_LENGTH + 1) },
    });
    fireEvent.click(screen.getByRole('button', { name: /save label/i }));

    expect(onSaveLabel).not.toHaveBeenCalled();
    expect(
      screen.getByText(new RegExp(String(MAX_ANNOTATION_LABEL_LENGTH))),
    ).toBeInTheDocument();
  });

  it('selects a color from the exported allowlist', () => {
    const { onSelectColor } = renderEditor();

    fireEvent.click(screen.getByRole('button', { name: 'Color #22c55e' }));

    expect(onSelectColor).toHaveBeenCalledWith('#22c55e');
  });

  it('toggles pin and mute', () => {
    const { onTogglePin, onToggleMute } = renderEditor();

    fireEvent.click(screen.getByRole('button', { name: /pin trader/i }));
    expect(onTogglePin).toHaveBeenCalledWith(true);

    fireEvent.click(screen.getByRole('button', { name: /mute trader/i }));
    expect(onToggleMute).toHaveBeenCalledWith(true);
  });

  it('deletes the annotation with a tombstone', () => {
    const { onDelete } = renderEditor({
      annotation: { traderId: 'trader-1', label: 'Whale', updatedAt: 1 },
    });

    fireEvent.click(screen.getByRole('button', { name: /remove label/i }));

    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});

interface StorageFake {
  local: LocalPreferencesStorage;
  records: Record<string, unknown>;
  onChanged: PopupDependencies['storage']['onChanged'];
  emit(changes: Record<string, unknown>): void;
}

function createStorageFake(initial: Record<string, unknown> = {}): StorageFake {
  const records: Record<string, unknown> = { ...initial };
  const listeners: Array<(changes: Record<string, unknown>, areaName: string) => void> = [];

  const local: LocalPreferencesStorage = {
    async get(keys: string[]): Promise<Record<string, unknown>> {
      const result: Record<string, unknown> = {};

      for (const key of keys) {
        if (key in records) {
          result[key] = records[key];
        }
      }

      return result;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      const changes: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(items)) {
        if (records[key] !== value) {
          changes[key] = { newValue: value };
        }
      }

      Object.assign(records, items);

      for (const listener of [...listeners]) {
        listener(changes, 'local');
      }
    },
  };

  return {
    local,
    records,
    onChanged: {
      addListener(fn: (changes: Record<string, unknown>, areaName: string) => void): void {
        listeners.push(fn);
      },
      removeListener(fn: (changes: Record<string, unknown>, areaName: string) => void): void {
        const index = listeners.indexOf(fn);

        if (index !== -1) {
          listeners.splice(index, 1);
        }
      },
    },
    emit(changes: Record<string, unknown>): void {
      for (const listener of [...listeners]) {
        listener(changes, 'local');
      }
    },
  };
}

const databases: FomoFeedDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
    void database.delete();
  }
});

async function renderAppWithEvent(
  event: TradeEventV1,
  initialStorage: Record<string, unknown> = {},
) {
  const database = new FomoFeedDatabase('editor-' + crypto.randomUUID());
  const repository = new EventRepository(database);

  databases.push(database);

  await repository.insert(event);

  const storage = createStorageFake({
    [SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS,
    ...initialStorage,
  });
  const sent: unknown[] = [];

  const runtime: PopupRuntimeLike = {
    async sendMessage(message: unknown): Promise<unknown> {
      sent.push(message);

      const parsed = parseExtensionMessage(message);

      if (!parsed.ok) {
        return undefined;
      }

      switch (parsed.message.type) {
        case 'events.query': {
          const events = await repository.page(parsed.message.payload as EventPageQuery);

          return { ok: true, events };
        }
        case 'events.markRead':
          await repository.markRead(
            parsed.message.payload.ids[0] ?? '',
            parsed.message.payload.at,
          );

          return { ok: true, marked: parsed.message.payload.ids.length };
        case 'connection.query':
          return { ok: true, connected: true, hasFomoTab: true };
        default:
          return undefined;
      }
    },
    onMessage: {
      addListener(): void {},
      removeListener(): void {},
    },
  };

  return { database, repository, storage, sent, runtime };
}

const cardCount = (container: HTMLElement): number =>
  container.querySelectorAll('.event-card').length;

describe('annotation flows inside the popup', () => {
  it('shows the stored inline note while omitting the legacy annotation editor', async () => {
    const { storage, runtime } = await renderAppWithEvent(makeEvent(), {
      [ANNOTATIONS_STORAGE_KEY]: {
        'trader-1': {
          traderId: 'trader-1',
          label: 'Whale',
          pinned: true,
          muted: true,
          updatedAt: 1,
        },
      },
    });

    const { container } = render(
      <PopupApp deps={{ runtime, storage, now: () => NOW }} />,
    );

    await waitFor(() => expect(cardCount(container)).toBe(1));

    expect(storage.records[ANNOTATIONS_STORAGE_KEY]).toMatchObject({
      'trader-1': { label: 'Whale', pinned: true, muted: true },
    });
    expect(
      screen.getByRole('button', { name: 'Edit trader note: Whale' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit label/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /label/i })).not.toBeInTheDocument();
  });
});
