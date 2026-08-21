import 'fake-indexeddb/auto';

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import { TranslatedOpinion } from '../../src/sidepanel/TranslatedOpinion';
import type {
  BrowserTranslationApi,
  ModelAvailability,
  TranslatorSession,
} from '../../src/translation/browser-translation';
import {
  TranslationActivationRequiredError,
} from '../../src/translation/browser-translation';
import { OpinionTranslationCoordinator } from '../../src/translation/opinion-translation';

// Strings render through useLocale (EN catalog here); the real provider
// behavior is covered by LocaleProvider.test.tsx.
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

const THESIS = 'Rotation into L1s';

function makeFakeTranslationApi(
  options: {
    availability?: ModelAvailability;
    detectLanguage?: string;
    translateGate?: Promise<string>;
    /** `create()` rejects with TranslationActivationRequiredError. */
    activationRequired?: boolean;
  } = {},
): BrowserTranslationApi {
  const detect = vi.fn(async () => ({
    language: options.detectLanguage ?? 'es',
    confidence: 0.99,
  }));
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
        translate: async (text: string) =>
          options.translateGate ?? Promise.resolve(`[translated] ${text}`),
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

function renderOpinion(props: Partial<Parameters<typeof TranslatedOpinion>[0]> = {}) {
  return render(
    <TranslatedOpinion
      text={THESIS}
      enabled={true}
      targetLanguage="auto"
      {...props}
    />,
  );
}

describe('TranslatedOpinion', () => {
  it('renders the original thesis on the first paint without waiting', () => {
    renderOpinion({ translationApi: makeFakeTranslationApi() });

    expect(screen.getByText(THESIS)).toBeInTheDocument();
  });

  it('makes the translated text primary and toggles to the original', async () => {
    renderOpinion({ translationApi: makeFakeTranslationApi() });

    await waitFor(() =>
      expect(screen.getByText(`[translated] ${THESIS}`)).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByRole('button', { name: /view original/i }));
    expect(screen.getByText(THESIS)).toBeInTheDocument();
    expect(screen.queryByText(`[translated] ${THESIS}`)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /view translation/i }));
    expect(screen.getByText(`[translated] ${THESIS}`)).toBeInTheDocument();
  });

  it('shows a localized translating state while the model is working', async () => {
    let release!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      release = resolve;
    });
    const translationApi = makeFakeTranslationApi({ translateGate: gate });

    renderOpinion({ translationApi });

    await waitFor(() =>
      expect(screen.getByText('Translating…')).toBeInTheDocument(),
    );

    await act(async () => {
      release(`[translated] ${THESIS}`);
    });

    expect(screen.queryByText('Translating…')).not.toBeInTheDocument();
    expect(screen.getByText(`[translated] ${THESIS}`)).toBeInTheDocument();
  });

  it('offers the enable action and keeps the original when activation is required', async () => {
    renderOpinion({
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
    expect(screen.getByText(THESIS)).toBeInTheDocument();
  });

  it('keeps the original primary and shows a compact unavailable state when the API is missing', async () => {
    // No injected api: the real adapter degrades to TranslationApiUnavailableError
    // in this environment (no Translator / LanguageDetector globals).
    renderOpinion();

    await waitFor(() =>
      expect(screen.getByText('Translation unavailable')).toBeInTheDocument(),
    );
    expect(screen.getByText(THESIS)).toBeInTheDocument();
  });

  it('never invokes translation when disabled', () => {
    const translationApi = makeFakeTranslationApi();

    renderOpinion({ enabled: false, translationApi });

    expect(screen.getByText(THESIS)).toBeInTheDocument();
    expect(translationApi.detect).not.toHaveBeenCalled();
    expect(screen.queryByText(/translat/i)).not.toBeInTheDocument();
  });

  it('shows the original only when the text is already in the target language', async () => {
    const translationApi = makeFakeTranslationApi({ detectLanguage: 'en' });

    renderOpinion({ translationApi });

    await waitFor(() => {
      expect(translationApi.detect).toHaveBeenCalled();
    });

    expect(screen.getByText(THESIS)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /view original/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/translat/i)).not.toBeInTheDocument();
  });

  it('translates through a shared coordinator and does not destroy it on unmount', async () => {
    const translationApi = makeFakeTranslationApi();
    const coordinator = new OpinionTranslationCoordinator({
      api: translationApi,
      browserLanguage: () => 'en',
    });

    const { unmount } = renderOpinion({ translationCoordinator: coordinator });

    await waitFor(() =>
      expect(screen.getByText(`[translated] ${THESIS}`)).toBeInTheDocument(),
    );

    unmount();

    // The shared coordinator belongs to the side panel root: the card's
    // unmount must not destroy it.
    await expect(coordinator.translate('other text')).resolves.toMatchObject({
      status: 'translated',
    });
  });
});
