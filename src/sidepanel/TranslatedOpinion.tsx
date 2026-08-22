import { useEffect, useMemo, useState } from 'react';

import type { TranslationTarget } from '../i18n/catalog';
import { useLocale } from '../i18n/LocaleProvider';
import type { BrowserTranslationApi } from '../translation/browser-translation';
import { createBrowserTranslationApi } from '../translation/browser-translation';
import type { OpinionTranslationCoordinator } from '../translation/opinion-translation';
import { useOpinionTranslation } from '../translation/use-opinion-translation';

/**
 * On-device opinion translation surface (plan Task 7, spec 9.2-9.4).
 *
 * Renders ONE thesis comment for the Side Panel history card:
 * - the original renders immediately and never waits for translation;
 * - while translation is pending, a localized `Translating…` status shows;
 * - on success the translated text becomes primary with a
 *   `View original` / `View translation` toggle;
 * - when the model needs user enablement, an `Enable local translation`
 *   action is offered (the click is a user activation, so Chrome may start
 *   the model download and the retry then succeeds);
 * - unavailable / failed states keep the original primary and show a compact
 *   localized status.
 *
 * The thesis text is untrusted user content: it is rendered as text and only
 * ever processed by the on-device opinion translator, never by the message
 * catalog. Toasts never use this component (they show the original only).
 */

export interface TranslatedOpinionProps {
  /** The untrusted original thesis comment. */
  text: string;
  /** `settings.opinionTranslation.enabled` (independent of the UI locale). */
  enabled: boolean;
  /** `settings.opinionTranslation.targetLanguage`; `auto` follows the browser language. */
  targetLanguage: TranslationTarget;
  /**
   * The side panel's shared on-device translation adapter. When omitted the
   * component builds its own (degrading to `unavailable` in older browsers).
   */
  translationApi?: BrowserTranslationApi;
  /**
   * The side panel's shared on-device translation coordinator (ONE per
   * panel). When provided the component uses it as-is and never destroys it
   * on unmount; the panel root owns it. When omitted the component owns a
   * per-card coordinator through useOpinionTranslation (legacy harness,
   * direct tests).
   */
  translationCoordinator?: OpinionTranslationCoordinator;
  /** Changes after the shared model is initialized, triggering an automatic retry. */
  retryToken?: number;
}

export function TranslatedOpinion(props: TranslatedOpinionProps) {
  const {
    text,
    enabled,
    targetLanguage,
    translationApi,
    translationCoordinator,
    retryToken = 0,
  } = props;
  const { translate } = useLocale();
  const [showOriginal, setShowOriginal] = useState(false);

  const preferences = useMemo(
    () => ({
      enabled,
      ...(targetLanguage === 'auto' ? {} : { target: targetLanguage }),
    }),
    [enabled, targetLanguage],
  );

  const fallbackTranslationApi = useMemo(() => createBrowserTranslationApi(), []);
  const api = translationApi ?? fallbackTranslationApi;

  const opinion = useOpinionTranslation({
    api,
    browserLanguage: () => navigator.language,
    preferences,
    ...(translationCoordinator !== undefined
      ? { coordinator: translationCoordinator }
      : {}),
  });

  // The hook's `translate` is stable; translate automatically whenever the
  // thesis is eligible, and re-request under the LATEST preferences when the
  // preference object or text changes (the hook invalidates stale work).
  const requestTranslation = opinion.translate;

  useEffect(() => {
    if (enabled) {
      requestTranslation(text);
    }
  }, [text, enabled, retryToken, requestTranslation]);

  // A new thesis starts with the translated view primary again.
  useEffect(() => {
    setShowOriginal(false);
  }, [text]);

  const translated =
    opinion.status === 'ready' && opinion.result?.status === 'translated'
      ? opinion.result.translated
      : undefined;
  const activationRequired =
    opinion.status === 'ready' && opinion.result?.status === 'activation-required';
  const unavailable =
    opinion.status === 'error' ||
    (opinion.status === 'ready' &&
      (opinion.result?.status === 'unavailable' || opinion.result?.status === 'failed'));

  return (
    <div className="event-thesis-block">
      {translated !== undefined && !showOriginal ? (
        <p className="event-thesis">{translated}</p>
      ) : (
        <p className="event-thesis">{text}</p>
      )}
      {opinion.status === 'translating' && (
        <span className="event-thesis-status" role="status">
          {translate('translation.translating')}
        </span>
      )}
      {translated !== undefined && (
        <button
          type="button"
          className="event-thesis-toggle"
          onClick={() => {
            setShowOriginal((visible) => !visible);
          }}
        >
          {showOriginal
            ? translate('translation.viewTranslation')
            : translate('translation.viewOriginal')}
        </button>
      )}
      {activationRequired && (
        <button
          type="button"
          className="event-thesis-activate"
          onClick={() => {
            // The click is a user activation: retrying translation lets
            // Chrome start the model download (spec 9.4).
            requestTranslation(text);
          }}
        >
          {translate('translation.enable')}
        </button>
      )}
      {unavailable && (
        <span className="event-thesis-status" role="status">
          {translate('translation.unavailable')}
        </span>
      )}
    </div>
  );
}
