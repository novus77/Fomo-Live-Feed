import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { TradeEventV1 } from '../../src/domain/activity';
import { DEFAULT_SETTINGS } from '../../src/domain/settings';
import { LocaleProvider, useLocale, type LocalePreferencesLike } from '../../src/i18n/LocaleProvider';
import * as historyFormat from '../../src/overlay/format';
import { HistoryFeed, type HistoryFeedProps } from '../../src/popup/HistoryFeed';
import type { BrowserTranslationApi } from '../../src/translation/browser-translation';

const NOW = 1_800_000_000_000;
const event: TradeEventV1 = {
  schemaVersion: 1,
  id: 'fomo:render-isolation',
  source: 'fomo',
  sources: ['fomo', 'pump'],
  traderId: 'trader-1',
  traderHandle: 'alpha',
  chain: 'bsc',
  tokenAddress: '0x020bfc650a365f8bb26819deaabf3e21291018b4',
  tokenSymbol: 'COIN',
  action: 'buy',
  usdAmount: 100,
  occurredAt: NOW - 60_000,
  receivedAt: NOW,
  readAt: NOW,
};

function LocaleSwitch() {
  const { setLocale } = useLocale();
  return <button onClick={() => setLocale('zh-CN')}>Switch language</button>;
}

const makeProps = (): HistoryFeedProps => ({
  events: [event],
  status: 'ready',
  hasMore: false,
  loadingMore: false,
  scanExceeded: false,
  noChainsSelected: false,
  settings: DEFAULT_SETTINGS,
  annotations: new Map(),
  now: () => NOW,
  copyText: vi.fn(async () => {}),
  openLink: vi.fn(),
  onOpenToken: vi.fn(),
  onLoadMore: vi.fn(),
  onRetry: vi.fn(),
  onSelectAllChains: vi.fn(),
  onUpsertAnnotation: vi.fn(),
  onDeleteAnnotation: vi.fn(),
});

const renderFeed = (initial: HistoryFeedProps) => {
  const preferences: LocalePreferencesLike = {
    getSettings: async () => ({ ...DEFAULT_SETTINGS, uiLocale: 'en' }),
    updateSettings: async (update) => ({ ...DEFAULT_SETTINGS, uiLocale: update.uiLocale ?? 'en' }),
  };
  const element = (props: HistoryFeedProps) => (
    <LocaleProvider preferences={preferences}>
      <LocaleSwitch />
      <HistoryFeed {...props} />
    </LocaleProvider>
  );
  const view = render(element(initial));
  return { ...view, update: (props: HistoryFeedProps) => view.rerender(element(props)) };
};

afterEach(() => { vi.restoreAllMocks(); });

describe('HistoryFeed render isolation', () => {
  it('skips real card formatting when its props and locale are unchanged', async () => {
    const props = makeProps();
    const formatTime = vi.spyOn(historyFormat, 'formatRelativeTime');
    const view = renderFeed(props);
    expect(await screen.findByText('$COIN')).toBeInTheDocument();
    expect(formatTime).toHaveBeenCalled();
    formatTime.mockClear();

    view.update(props);
    expect(screen.getByText('$COIN')).toBeInTheDocument();
    expect(formatTime).not.toHaveBeenCalled();
  });

  it('updates changed event data, notes, and source projection', async () => {
    const props = makeProps();
    const view = renderFeed(props);
    expect(await screen.findByText('$COIN')).toBeInTheDocument();
    expect(screen.getByLabelText('Fomo + Pump')).toBeInTheDocument();

    const changedEvent: HistoryFeedProps = {
      ...props,
      events: [{ ...event, tokenSymbol: 'NEW', usdAmount: 42 }],
    };
    view.update(changedEvent);
    expect(screen.getByText('$NEW')).toBeInTheDocument();
    expect(screen.getByText('$42')).toBeInTheDocument();
    expect(screen.queryByText('$COIN')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Fomo + Pump')).toBeInTheDocument();
    const changedNote: HistoryFeedProps = {
      ...changedEvent,
      annotations: new Map([['trader-1', { traderId: 'trader-1', label: 'Momentum', updatedAt: NOW }]]),
    };
    view.update(changedNote);
    expect(screen.getByRole('button', { name: 'Edit trader note: Momentum' })).toBeInTheDocument();
    expect(screen.getByLabelText('Fomo + Pump')).toBeInTheDocument();
    view.update({ ...changedNote, sourceFilter: 'fomo' });
    expect(screen.getByLabelText('Fomo')).toBeInTheDocument();
    expect(screen.queryByLabelText('Fomo + Pump')).not.toBeInTheDocument();
  });

  it('updates real locale context consumers even with unchanged feed props', async () => {
    const props = makeProps();
    renderFeed(props);
    expect(await screen.findByText('Buy')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Switch language' }));
    expect(screen.getByText('买入')).toBeInTheDocument();
    expect(screen.queryByText('Buy')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '＋备注' })).toBeInTheDocument();
  });

  it('applies changed translation settings and a subsequent model retry token', async () => {
    const props = makeProps();
    let available = false;
    const api: BrowserTranslationApi = {
      detect: vi.fn(async () => ({ language: 'es', confidence: 1 })),
      availability: async () => available ? 'available' : 'unavailable',
      create: async () => ({ translate: async () => 'Translated opinion', destroy() {} }),
    };
    const initial: HistoryFeedProps = {
      ...props,
      events: [{ ...event, action: 'thesis', thesis: 'Buenos días' }],
      settings: { ...DEFAULT_SETTINGS, opinionTranslation: { enabled: false, targetLanguage: 'zh' } },
      translationApi: api,
      translationRetryToken: 0,
    };
    const view = renderFeed(initial);
    expect(await screen.findByText('Buenos días')).toBeInTheDocument();
    expect(api.detect).not.toHaveBeenCalled();

    const enabled: HistoryFeedProps = {
      ...initial,
      settings: { ...DEFAULT_SETTINGS, opinionTranslation: { enabled: true, targetLanguage: 'zh' } },
    };
    view.update(enabled);
    await waitFor(() => expect(api.detect).toHaveBeenCalled());
    expect(await screen.findByText('Translation unavailable')).toBeInTheDocument();
    available = true;
    view.update({ ...enabled, translationRetryToken: 1 });
    expect(await screen.findByText('Translated opinion')).toBeInTheDocument();
  });

  it('uses replaced action callbacks and preserves card-local interaction', async () => {
    const props = { ...makeProps(), hasMore: true };
    const view = renderFeed(props);
    expect(await screen.findByText('$COIN')).toBeInTheDocument();
    const copyText = vi.fn(async () => {});
    const onOpenToken = vi.fn();
    const onLoadMore = vi.fn();
    const onUpsertAnnotation = vi.fn();
    view.update({ ...props, copyText, onOpenToken, onLoadMore, onUpsertAnnotation });

    fireEvent.click(screen.getByRole('button', { name: '$COIN' }));
    expect(onOpenToken).toHaveBeenCalledWith({
      source: 'fomo', chain: 'bsc', tokenAddress: event.tokenAddress,
    });
    expect(props.onOpenToken).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalledTimes(1);
    expect(props.onLoadMore).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Copy full address' }));
    await act(async () => {});
    expect(copyText).toHaveBeenCalledWith(event.tokenAddress);
    expect(props.copyText).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '＋Note' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Trader note' }), {
      target: { value: 'Local note' },
    });
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Trader note' }), { key: 'Enter' });
    expect(onUpsertAnnotation).toHaveBeenCalledWith(event.traderId, { label: 'Local note' });
    expect(props.onUpsertAnnotation).not.toHaveBeenCalled();
  });
});
