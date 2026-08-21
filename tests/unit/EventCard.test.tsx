import 'fake-indexeddb/auto';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { TradeEventV1 } from '../../src/domain/activity';
import { DEFAULT_SETTINGS, type LocalSettingsV3 } from '../../src/domain/settings';
import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import { EventCard, type EventCardProps } from '../../src/popup/EventCard';
import type {
  BrowserTranslationApi,
  ModelAvailability,
  TranslatorSession,
} from '../../src/translation/browser-translation';
import {
  TranslationActivationRequiredError,
} from '../../src/translation/browser-translation';

// Card strings render through useLocale (EN catalog here); the real provider
// behavior is covered by LocaleProvider.test.tsx. Opinion translation uses
// the real useOpinionTranslation hook with an injected fake browser API.
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
    usdAmount: 1250.5,
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
      openLink={vi.fn()}
      onUpsertAnnotation={callbacks.onUpsertAnnotation}
      onDeleteAnnotation={callbacks.onDeleteAnnotation}
      {...overrides}
    />,
  );
}

const settingsWithTranslation = (
  enabled: boolean,
  targetLanguage: LocalSettingsV3['opinionTranslation']['targetLanguage'] = 'auto',
): LocalSettingsV3 => ({
  ...DEFAULT_SETTINGS,
  opinionTranslation: { enabled, targetLanguage },
});

describe('EventCard', () => {
  it('renders action, token, and trader identity', () => {
    renderCard(makeEvent());

    expect(screen.getByText('Buy')).toBeInTheDocument();
    expect(screen.getByText('$FOMO')).toBeInTheDocument();
    expect(screen.getByText('Alpha Whale')).toBeInTheDocument();
    expect(screen.getByText('@alpha')).toBeInTheDocument();
    // The metric grid has been removed (Task 5); the card shows no metric labels.
    expect(screen.queryByText('7d PnL')).not.toBeInTheDocument();
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

  it('makes the translated thesis primary with a View original toggle', async () => {
    const event = makeEvent({ thesis: 'Rotation into L1s' });

    renderCard(event, {
      settings: settingsWithTranslation(true),
      translationApi: makeFakeTranslationApi(),
    });

    await waitFor(() =>
      expect(screen.getByText('[translated] Rotation into L1s')).toBeInTheDocument(),
    );

    const toggle = screen.getByRole('button', { name: /view original/i });
    fireEvent.click(toggle);
    expect(screen.getByText('Rotation into L1s')).toBeInTheDocument();
    expect(screen.queryByText('[translated] Rotation into L1s')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /view translation/i }));
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
    const event = makeEvent({ thesis: 'Rotation into L1s' });

    // No injected api: EventCard builds the real adapter, which degrades to
    // TranslationApiUnavailableError in this environment (no Translator).
    renderCard(event, { settings: settingsWithTranslation(true) });

    await waitFor(() =>
      expect(screen.getByText('Translation unavailable')).toBeInTheDocument(),
    );
    expect(screen.getByText('Rotation into L1s')).toBeInTheDocument();
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
