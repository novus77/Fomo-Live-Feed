import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TradeEventV1 } from '../../src/domain/activity';
import { DEFAULT_SETTINGS } from '../../src/domain/settings';
import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import { parseExtensionMessage } from '../../src/messaging/protocol';
import { PopupApp } from '../../src/popup/PopupApp';
import { SettingsPanel } from '../../src/popup/SettingsPanel';
import type { PopupRuntimeLike } from '../../src/popup/popup-io';
import type { EventPageQuery } from '../../src/storage/event-repository';
import { FomoFeedDatabase } from '../../src/storage/database';
import { EventRepository } from '../../src/storage/event-repository';
import {
  SETTINGS_STORAGE_KEY,
  type LocalPreferencesStorage,
} from '../../src/storage/local-preferences';

// Settings strings render through useLocale (EN catalog here); the real
// provider behavior is covered by LocaleProvider.test.tsx. The shared spy
// lets tests assert the settings EN / 中文 switch wiring.
const { mockSetLocale } = vi.hoisted(() => ({ mockSetLocale: vi.fn() }));

vi.mock('../../src/i18n/LocaleProvider', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/i18n/LocaleProvider')>();
  const { translate: translateMessage } = await import('../../src/i18n/catalog');

  const useLocale = (): LocaleContextValue => ({
    locale: 'en',
    setLocale: mockSetLocale,
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
    usdAmount: 1250.5,
    occurredAt: NOW - 60_000,
    receivedAt: NOW,
    metricSnapshot: {
      fetchedAt: NOW,
      source: 'fomo-profile',
      pnl7d: 1250,
      winRate7d: 62.5,
      followers: 1234,
      tradeCount: 88,
      averageHoldSeconds: 4200,
    },
    ...overrides,
  };
}

function renderPanel(
  settings = DEFAULT_SETTINGS,
) {
  const onOpinionTranslationChange = vi.fn();
  const onThemeChange = vi.fn();
  const onNotificationsChange = vi.fn();
  const onFinancialDisplayChange = vi.fn();

  const utils = render(
    <SettingsPanel
      settings={settings}
      onOpinionTranslationChange={onOpinionTranslationChange}
      onThemeChange={onThemeChange}
      onNotificationsChange={onNotificationsChange}
      onFinancialDisplayChange={onFinancialDisplayChange}
    />,
  );

  return {
    ...utils,
    onOpinionTranslationChange,
    onThemeChange,
    onNotificationsChange,
    onFinancialDisplayChange,
  };
}

describe('SettingsPanel', () => {
  it('groups every preference into compact setting rows', () => {
    const { container } = renderPanel();

    expect(container.querySelector('.settings-panel')).toHaveClass('utility-panel');
    expect(container.querySelectorAll('.settings-section')).toHaveLength(5);
    expect(container.querySelectorAll('.settings-toggle-row')).toHaveLength(2);
  });

  it('wires independent financial display updates', () => {
    const { onFinancialDisplayChange } = renderPanel();

    fireEvent.change(screen.getByRole('slider', { name: 'Sell amount font size' }), {
      target: { value: '17' },
    });

    expect(onFinancialDisplayChange).toHaveBeenCalledWith({
      sellAmount: { fontSizePx: 17 },
    });
  });

  it('renders and updates the global buy sound setting', () => {
    const { onNotificationsChange } = renderPanel({
      ...DEFAULT_SETTINGS,
      notifications: { ...DEFAULT_SETTINGS.notifications, soundEnabled: true },
    });
    const toggle = screen.getByRole('checkbox', { name: 'Buy sound alert' });

    expect(toggle).toBeChecked();
    expect(screen.getByText('Play a sound for each new live buy.')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(onNotificationsChange).toHaveBeenCalledWith({ soundEnabled: false });
  });
  it('renders the language section and hides metric controls', () => {
    renderPanel();

    expect(screen.getByRole('group', { name: /switch ui language/i })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /primary metric/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /secondary metric/i })).not.toBeInTheDocument();
  });

  it('toggles opinion translation and changes the target language', () => {
    const { onOpinionTranslationChange } = renderPanel();

    const toggle = screen.getByRole('checkbox', { name: /enable local translation/i });
    const target = screen.getByRole('combobox', { name: /target language/i });

    expect(toggle).toBeChecked();
    expect(target).not.toBeDisabled();
    expect(target).toHaveValue('auto');

    fireEvent.click(toggle);
    expect(onOpinionTranslationChange).toHaveBeenCalledWith({ enabled: false });

    fireEvent.change(target, { target: { value: 'zh' } });
    expect(onOpinionTranslationChange).toHaveBeenCalledWith({ targetLanguage: 'zh' });
  });

  it('disables the target select while translation is off', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      opinionTranslation: { enabled: false, targetLanguage: 'auto' as const },
    };

    renderPanel(settings);

    expect(screen.getByRole('checkbox', { name: /enable local translation/i })).not.toBeChecked();
    expect(screen.getByRole('combobox', { name: /target language/i })).toBeDisabled();
  });

  it('removes manual translation initialization while keeping automatic controls', () => {
    renderPanel();

    expect(screen.queryByRole('button', { name: /initialize local translation/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /enable local translation/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /target language/i })).toBeInTheDocument();
  });

  it('switches between persisted light and dark themes', () => {
    const { onThemeChange } = renderPanel();
    const group = screen.getByRole('group', { name: /theme/i });
    const light = within(group).getByRole('button', { name: /light/i });
    const dark = within(group).getByRole('button', { name: /dark/i });

    expect(light).toHaveAttribute('aria-pressed', 'false');
    expect(dark).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(light);
    fireEvent.click(dark);
    expect(onThemeChange).toHaveBeenNthCalledWith(1, 'light');
    expect(onThemeChange).toHaveBeenNthCalledWith(2, 'dark');
  });

  it('wires the settings EN / 中文 control to the UI-locale switch', () => {
    renderPanel();

    const group = screen.getByRole('group', { name: /switch ui language/i });
    const en = within(group).getByRole('button', { name: 'EN' });
    const zh = within(group).getByRole('button', { name: '中文' });

    expect(en).toHaveAttribute('aria-pressed', 'true');
    expect(zh).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(zh);
    expect(mockSetLocale).toHaveBeenCalledWith('zh-CN');

    fireEvent.click(en);
    expect(mockSetLocale).toHaveBeenCalledWith('en');
  });
});

interface StorageFake {
  local: LocalPreferencesStorage;
  records: Record<string, unknown>;
  onChanged: {
    addListener(fn: (changes: Record<string, unknown>, areaName: string) => void): void;
    removeListener(fn: (changes: Record<string, unknown>, areaName: string) => void): void;
  };
}

function createStorageFake(initial: Record<string, unknown> = {}) {
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

  const storage: StorageFake = {
    local,
    records,
    onChanged: {
      addListener(fn) {
        listeners.push(fn);
      },
      removeListener(fn) {
        const index = listeners.indexOf(fn);

        if (index !== -1) {
          listeners.splice(index, 1);
        }
      },
    },
  };

  return storage;
}

const databases: FomoFeedDatabase[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
    void database.delete();
  }
});

describe('opinion translation settings inside the popup', () => {
  it('persists an opinion-translation change and notifies the worker', async () => {
    const database = new FomoFeedDatabase('settings-' + crypto.randomUUID());
    const repository = new EventRepository(database);

    databases.push(database);

    await repository.insert(makeEvent());

    const storage = createStorageFake({ [SETTINGS_STORAGE_KEY]: DEFAULT_SETTINGS });
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

    const { container } = render(<PopupApp deps={{ runtime, storage, now: () => NOW }} />);

    await waitFor(() => expect(container.querySelectorAll('.event-card')).toHaveLength(1));

    fireEvent.click(screen.getByRole('button', { name: /settings/i }));

    const toggle = screen.getByRole('checkbox', { name: /enable local translation/i });
    fireEvent.click(toggle);

    await waitFor(() => {
      const stored = storage.records[SETTINGS_STORAGE_KEY] as {
        opinionTranslation?: { enabled?: boolean };
      };
      expect(stored.opinionTranslation?.enabled).toBe(false);
    });

    const preferencesChanged = sent.filter((message) => {
      const parsed = parseExtensionMessage(message);

      return parsed.ok && parsed.message.type === 'preferences.changed';
    });

    expect(preferencesChanged.length).toBeGreaterThan(0);
  });
});
