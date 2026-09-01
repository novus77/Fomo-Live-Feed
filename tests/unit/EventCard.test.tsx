import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { TradeEventV1 } from '../../src/domain/activity';
import { DEFAULT_SETTINGS, type LocalSettingsV4 } from '../../src/domain/settings';
import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import type { UiLocale } from '../../src/i18n/catalog';
import { formatRelativeTime } from '../../src/overlay/format';
import { EventCard, type EventCardProps } from '../../src/popup/EventCard';
import type {
  BrowserTranslationApi,
  ModelAvailability,
  TranslatorSession,
} from '../../src/translation/browser-translation';
import {
  TranslationActivationRequiredError,
} from '../../src/translation/browser-translation';

// Card strings render through useLocale (controlled catalog locale here); the real provider
// behavior is covered by LocaleProvider.test.tsx. Opinion translation uses
// the real useOpinionTranslation hook with an injected fake browser API.
const localeState = vi.hoisted(() => ({ current: 'en' as UiLocale }));

vi.mock('../../src/i18n/LocaleProvider', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/i18n/LocaleProvider')>();
  const { translate: translateMessage } = await import('../../src/i18n/catalog');

  const useLocale = (): LocaleContextValue => ({
    locale: localeState.current,
    setLocale: () => {},
    translate: (key, values) => translateMessage(localeState.current, key, values),
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
    marketCap: 4_200_000,
    occurredAt: NOW - 60_000,
    receivedAt: NOW,
    metricSnapshot: {
      fetchedAt: NOW,
      source: 'fomo-profile',
      pnl7d: 1250,
      winRate7d: 62.5,
    },
    ...overrides,
  };
}

function makeEventWithoutFinancialValues(
  fields: Array<'usdAmount' | 'marketCap'>,
  overrides: Partial<TradeEventV1> = {},
): TradeEventV1 {
  const event = makeEvent(overrides);

  for (const field of fields) {
    delete event[field];
  }

  return event;
}

function makeFakeTranslationApi(
  options: {
    availability?: ModelAvailability;
    detectRejects?: boolean;
    /** `create()` rejects with TranslationActivationRequiredError. */
    activationRequired?: boolean;
  } = {},
): BrowserTranslationApi {
  const detect = vi.fn(async () => {
    if (options.detectRejects === true) {
      throw new Error('detection failed');
    }
    return { language: 'es', confidence: 0.99 };
  });
  const availability = vi.fn(
    async (_source: string, _target: string): Promise<ModelAvailability> =>
      options.availability ?? 'available',
  );
  const create = vi.fn(
    async (_source: string, _target: string): Promise<TranslatorSession> => {
      if (options.activationRequired === true) {
        throw new TranslationActivationRequiredError();
      }
      return {
        translate: async (text: string) => `[translated] ${text}`,
        destroy: () => {},
      };
    },
  );

  return {
    detect,
    availability,
    create,
  } as unknown as BrowserTranslationApi & {
    detect: typeof detect;
    availability: typeof availability;
    create: typeof create;
  };
}

function renderCard(
  event: TradeEventV1,
  overrides: Partial<Omit<EventCardProps, 'event'>> = {},
) {
  const callbacks = {
    onUpsertAnnotation: vi.fn(),
    onDeleteAnnotation: vi.fn(),
  };

  return render(
    <EventCard
      event={event}
      settings={DEFAULT_SETTINGS}
      annotation={undefined}
      now={() => NOW}
      copyText={vi.fn().mockResolvedValue(undefined)}
      onOpenToken={vi.fn()}
      onUpsertAnnotation={callbacks.onUpsertAnnotation}
      onDeleteAnnotation={callbacks.onDeleteAnnotation}
      {...overrides}
    />,
  );
}

const settingsWithTranslation = (
  enabled: boolean,
  targetLanguage: LocalSettingsV4['opinionTranslation']['targetLanguage'] = 'auto',
): LocalSettingsV4 => ({
  ...DEFAULT_SETTINGS,
  opinionTranslation: { enabled, targetLanguage },
});

describe('EventCard', () => {
  it.each([
    ['buy', 'event-card-buy'],
    ['sell', 'event-card-sell'],
    ['thesis', 'event-card-thesis'],
    ['transfer', 'event-card-transfer'],
    ['withdraw', 'event-card-withdraw'],
  ] as const)('marks %s cards with a semantic presentation class', (action, expected) => {
    const { container } = renderCard(makeEvent({ action }));
    const card = container.querySelector('article');

    expect(card).toHaveClass('event-card', expected);
    expect(card).toHaveAttribute('data-event-action', action);
  });

  it('opens only from a supported token symbol and leaves card whitespace inert', () => {
    const onOpenToken = vi.fn();
    const { container } = renderCard(makeEvent(), { onOpenToken });
    container.querySelector('article')?.click();
    expect(onOpenToken).not.toHaveBeenCalled();
    screen.getByRole('button', { name: '$FOMO' }).click();
    expect(onOpenToken).toHaveBeenCalledWith({
      chain: 'bsc',
      tokenAddress: '0x020bfc650a365f8bb26819deaabf3e21291018b4',
    });
  });

  it.each(['base', 'ethereum', 'x-layer', 'unknown'] as const)(
    'renders unsupported %s token identity as plain text',
    (chain) => {
      renderCard({ ...makeEvent(), chain });
      expect(screen.queryByRole('button', { name: '$FOMO' })).not.toBeInTheDocument();
      expect(screen.getByText('$FOMO')).toBeInTheDocument();
    },
  );
  it('keeps stored annotations out of the clean feed UI', () => {
    renderCard(makeEvent(), {
      annotation: {
        traderId: 'trader-1',
        label: 'Whale',
        color: '#2563eb',
        pinned: true,
        updatedAt: NOW,
      },
    });

    expect(screen.queryByText('Whale')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /edit label/i })).not.toBeInTheDocument();
  });

  it('renders action, token, and trader identity', () => {
    renderCard(makeEvent());

    expect(screen.getByText('Buy')).toBeInTheDocument();
    expect(screen.getByText('$FOMO')).toBeInTheDocument();
    expect(screen.getByText('Alpha Whale')).toBeInTheDocument();
    expect(screen.getByText('@alpha')).toBeInTheDocument();
    // The metric grid has been removed (Task 5); the card shows no metric labels.
    expect(screen.queryByText('7d PnL')).not.toBeInTheDocument();
  });

  it('keeps the relative time beside the trader name on the primary identity line', () => {
    const event = makeEvent();
    const { container } = renderCard(event);
    const primary = container.querySelector<HTMLElement>('.event-trader-primary');
    const traderName = container.querySelector<HTMLElement>('.event-trader-name');
    const eventTime = container.querySelector<HTMLElement>('.event-time');
    const traderHandle = container.querySelector<HTMLElement>('.event-trader-handle');

    expect(primary).toContainElement(traderName);
    expect(primary).toContainElement(eventTime);
    expect(eventTime).toHaveTextContent(formatRelativeTime(event.occurredAt, NOW));
    expect(primary).not.toContainElement(traderHandle);
    expect(container.querySelector<HTMLElement>('.event-identity-text')).toContainElement(
      traderHandle,
    );
    expect(container.querySelector('.event-action-line .event-time')).not.toBeInTheDocument();
  });

  it('renders both amount and market cap when both are available', () => {
    const { container } = renderCard(makeEvent());

    expect(container.querySelector('.event-amount')).toHaveTextContent('$1.25K');
    expect(container.querySelector('.event-market-cap')).toHaveTextContent('MC: $4.2M');
  });

  it('keeps token image, symbol, and chain badge in one identity group', () => {
    const { container } = renderCard(makeEvent());
    const tokenIdentity = container.querySelector('.event-token-identity');

    expect(tokenIdentity).toContainElement(
      container.querySelector('.event-token-image, .event-token-fallback'),
    );
    expect(tokenIdentity).toContainElement(container.querySelector('.event-token-symbol'));
    expect(tokenIdentity).toContainElement(container.querySelector('.event-chain-badge'));
  });

  it('keeps the market cap label stable in the Chinese locale', () => {
    localeState.current = 'zh-CN';
    const { container } = renderCard(makeEvent());
    localeState.current = 'en';

    expect(container.querySelector('.event-market-cap')).toHaveTextContent('MC: $4.2M');
  });

  it('renders only amount when market cap is missing', () => {
    const { container } = renderCard(makeEventWithoutFinancialValues(['marketCap']));

    expect(container.querySelector('.event-amount')).toHaveTextContent('$1.25K');
    expect(container.querySelector('.event-market-cap')).not.toBeInTheDocument();
  });

  it('renders only market cap when amount is missing', () => {
    const { container } = renderCard(makeEventWithoutFinancialValues(['usdAmount']));

    expect(container.querySelector('.event-amount')).not.toBeInTheDocument();
    expect(container.querySelector('.event-market-cap')).toHaveTextContent('MC: $4.2M');
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
  });

  it('omits missing financial values without hiding the thesis', () => {
    const { container } = renderCard(
      makeEventWithoutFinancialValues(['usdAmount', 'marketCap'], { thesis: 'Still bullish' }),
    );

    expect(container.querySelector('.event-amount')).not.toBeInTheDocument();
    expect(container.querySelector('.event-market-cap')).not.toBeInTheDocument();
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
    expect(screen.getByText('Still bullish')).toBeInTheDocument();
  });

  it('renders real zero amount and market cap values', () => {
    const { container } = renderCard(makeEvent({ usdAmount: 0, marketCap: 0 }));

    expect(container.querySelector('.event-amount')).toHaveTextContent('$0');
    expect(container.querySelector('.event-market-cap')).toHaveTextContent('MC: $0');
  });

  it.each([
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['negative infinity', Number.NEGATIVE_INFINITY],
  ])('omits non-finite %s financial values', (_label, value) => {
    const { container } = renderCard(makeEvent({ usdAmount: value, marketCap: value }));

    expect(container.querySelector('.event-amount')).not.toBeInTheDocument();
    expect(container.querySelector('.event-market-cap')).not.toBeInTheDocument();
    expect(screen.queryByText('Unavailable')).not.toBeInTheDocument();
  });

  it('renders inline followers only when a valid value exists', () => {
    renderCard(makeEvent({ metricSnapshot: { fetchedAt: NOW, source: 'fomo-profile', followers: 1234 } }));

    expect(screen.getByText(/1\.23K followers/)).toBeInTheDocument();
  });

  it('omits the followers suffix for invalid or missing values', () => {
    renderCard(makeEvent({ metricSnapshot: { fetchedAt: NOW, source: 'fomo-profile' } }));

    expect(screen.queryByText(/followers/i)).not.toBeInTheDocument();
  });

  it('shows the original thesis immediately and never waits for translation', () => {
    const event = makeEvent({ thesis: 'Rotation into L1s' });

    renderCard(event, {
      settings: settingsWithTranslation(true),
      translationApi: makeFakeTranslationApi(),
    });

    // The original renders on the first paint.
    expect(screen.getByText('Rotation into L1s')).toBeInTheDocument();
  });

  it('shows the translated thesis below the original', async () => {
    const event = makeEvent({ thesis: 'Rotation into L1s' });

    renderCard(event, {
      settings: settingsWithTranslation(true),
      translationApi: makeFakeTranslationApi(),
    });

    await waitFor(() =>
      expect(screen.getByText('[translated] Rotation into L1s')).toBeInTheDocument(),
    );

    expect(screen.getByText('Rotation into L1s')).toBeInTheDocument();
    expect(screen.getByText('[translated] Rotation into L1s')).toBeInTheDocument();
  });

  it('keeps the original primary when the model needs user activation', async () => {
    const event = makeEvent({ thesis: 'Rotation into L1s' });

    renderCard(event, {
      settings: settingsWithTranslation(true),
      translationApi: makeFakeTranslationApi({
        availability: 'downloadable',
        activationRequired: true,
      }),
    });

    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: /enable local translation/i }),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('Rotation into L1s')).toBeInTheDocument();
  });

  it('keeps the original primary and shows a compact unavailable state when the API is missing', async () => {
    const event = makeEvent({ thesis: 'GM' });

    // No injected api: EventCard builds the real adapter, which degrades to
    // TranslationApiUnavailableError in this environment (no Translator).
    renderCard(event, { settings: settingsWithTranslation(true) });

    await waitFor(() =>
      expect(screen.getByText('Translation unavailable')).toBeInTheDocument(),
    );
    expect(screen.getByText('GM')).toBeInTheDocument();
  });

  it('never invokes translation when disabled', () => {
    const event = makeEvent({ thesis: 'Rotation into L1s' });
    const translationApi = makeFakeTranslationApi();

    renderCard(event, {
      settings: settingsWithTranslation(false),
      translationApi,
    });

    expect(screen.getByText('Rotation into L1s')).toBeInTheDocument();
    expect(translationApi.detect).not.toHaveBeenCalled();
    expect(screen.queryByText(/translat/i)).not.toBeInTheDocument();
  });

  it('shows the original only when the thesis is already in the target language', async () => {
    const event = makeEvent({ thesis: 'Already in English' });
    const translationApi = makeFakeTranslationApi();

    // The detector reports the thesis is already English (the target): the
    // coordinator must bypass the translator and leave the text unchanged.
    vi.mocked(translationApi.detect).mockResolvedValue({
      language: 'en',
      confidence: 0.99,
    });

    renderCard(event, {
      settings: settingsWithTranslation(true),
      translationApi,
    });

    await waitFor(() => {
      expect(translationApi.detect).toHaveBeenCalled();
    });

    expect(screen.getByText('Already in English')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /view original/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/translat/i)).not.toBeInTheDocument();
  });
});
