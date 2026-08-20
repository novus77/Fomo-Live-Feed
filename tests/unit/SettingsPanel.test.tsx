import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TradeEventV1 } from '../../src/domain/activity';
import { DEFAULT_SETTINGS, type MetricKey } from '../../src/domain/settings';
import { parseExtensionMessage } from '../../src/messaging/protocol';
import { PopupApp } from '../../src/popup/PopupApp';
import {
  SettingsPanel,
  applyMetricSlotChange,
} from '../../src/popup/SettingsPanel';
import type { PopupRuntimeLike } from '../../src/popup/popup-io';
import type { EventPageQuery } from '../../src/storage/event-repository';
import { FomoFeedDatabase } from '../../src/storage/database';
import { EventRepository } from '../../src/storage/event-repository';
import {
  SETTINGS_STORAGE_KEY,
  type LocalPreferencesStorage,
} from '../../src/storage/local-preferences';

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

describe('applyMetricSlotChange', () => {
  it('keeps the defaults for an unchanged slot', () => {
    const result = applyMetricSlotChange(
      DEFAULT_SETTINGS.metrics,
      'secondary',
      'winRate7d' as MetricKey,
    );

    expect(result).toEqual({
      ok: true,
      metrics: { primary: 'pnl7d', secondary: 'winRate7d' },
    });
  });

  it('disables a slot by omitting its key', () => {
    const result = applyMetricSlotChange(
      DEFAULT_SETTINGS.metrics,
      'secondary',
      undefined,
    );

    expect(result).toEqual({ ok: true, metrics: { primary: 'pnl7d' } });
  });

  it('rejects a duplicate primary/secondary selection', () => {
    const result = applyMetricSlotChange(
      DEFAULT_SETTINGS.metrics,
      'primary',
      'winRate7d' as MetricKey,
    );

    expect(result).toEqual({
      ok: false,
      reason: expect.stringContaining('already'),
    });
  });

  it('replaces a slot with a different metric', () => {
    const result = applyMetricSlotChange(
      DEFAULT_SETTINGS.metrics,
      'primary',
      'followers' as MetricKey,
    );

    expect(result).toEqual({
      ok: true,
      metrics: { primary: 'followers', secondary: 'winRate7d' },
    });
  });
});

function renderPanel(settings = DEFAULT_SETTINGS) {
  const onChange = vi.fn();

  const utils = render(<SettingsPanel settings={settings} onChange={onChange} />);

  return { ...utils, onChange };
}

describe('SettingsPanel', () => {
  it('renders the honest 7-day metric labels with the defaults selected', () => {
    renderPanel();

    const primary = screen.getByRole('combobox', { name: /primary metric/i });
    const secondary = screen.getByRole('combobox', { name: /secondary metric/i });

    expect(within(primary).getByText('7d PnL')).toBeInTheDocument();
    expect(within(secondary).getByText('7d Win Rate')).toBeInTheDocument();

    const options = within(primary).getAllByRole('option').map((option) => option.textContent);

    expect(options).toEqual(
      expect.arrayContaining(['7d PnL', '7d Win Rate', 'Followers', 'Trades', 'Avg Hold', 'Disabled']),
    );
  });

  it('disables a slot and omits its key from the update', () => {
    const { onChange } = renderPanel();

    fireEvent.change(screen.getByRole('combobox', { name: /secondary metric/i }), {
      target: { value: 'none' },
    });

    expect(onChange).toHaveBeenCalledWith({ primary: 'pnl7d' });
  });

  it('rejects selecting the same metric in both slots', () => {
    const { onChange } = renderPanel();

    fireEvent.change(screen.getByRole('combobox', { name: /primary metric/i }), {
      target: { value: 'winRate7d' },
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText(/already/i)).toBeInTheDocument();
  });

  it('replaces a slot with a different metric', () => {
    const { onChange } = renderPanel();

    fireEvent.change(screen.getByRole('combobox', { name: /primary metric/i }), {
      target: { value: 'followers' },
    });

    expect(onChange).toHaveBeenCalledWith({ primary: 'followers', secondary: 'winRate7d' });
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

describe('metric settings inside the popup', () => {
  it('persists a metric change, notifies the worker, and re-renders the card', async () => {
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

    const { container } = render(
      <PopupApp deps={{ runtime, storage, now: () => NOW }} />,
    );

    await waitFor(() =>
      expect(container.querySelectorAll('.event-card')).toHaveLength(1),
    );

    // Open the settings panel and replace the primary metric.
    fireEvent.click(screen.getByRole('button', { name: /settings/i }));

    fireEvent.change(screen.getByRole('combobox', { name: /primary metric/i }), {
      target: { value: 'followers' },
    });

    await waitFor(() => {
      const stored = storage.records[SETTINGS_STORAGE_KEY] as {
        metrics?: { primary?: MetricKey };
      };
      expect(stored.metrics?.primary).toBe('followers');
    });

    const preferencesChanged = sent.filter((message) => {
      const parsed = parseExtensionMessage(message);

      return parsed.ok && parsed.message.type === 'preferences.changed';
    });

    expect(preferencesChanged.length).toBeGreaterThan(0);

    // The card now shows the replaced metric with its honest label (the
    // panel's select option also says "Followers", so scope to the card).
    const card = container.querySelector('.event-card') as HTMLElement | null;

    if (card === null) {
      throw new Error('missing event card');
    }

    expect(within(card).getByText('Followers')).toBeInTheDocument();
    expect(within(card).getByText('1.23K')).toBeInTheDocument();
  });
});
