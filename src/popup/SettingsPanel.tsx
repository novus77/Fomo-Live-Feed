import { useState } from 'react';

import {
  METRIC_KEYS,
  type LocalSettingsV2,
  type MetricKey,
} from '../domain/settings';
import type { TranslationTarget } from '../i18n/catalog';
import { useLocale } from '../i18n/LocaleProvider';
import { METRIC_LABEL_KEYS } from '../overlay/format';

const SLOTS = ['primary', 'secondary'] as const;
export type MetricSlot = (typeof SLOTS)[number];

export type MetricSlotChangeResult =
  | { ok: true; metrics: LocalSettingsV2['metrics'] }
  | { ok: false; reason: string };

/**
 * Pure slot-update rule (plan Task 10 Step 2, spec section 5.4):
 * - the same metric cannot fill both slots (duplicate selection is rejected);
 * - selecting Disabled omits the slot's key entirely;
 * - the 7-day labels come from the localized metric keys so the window is
 *   stated honestly and a lifetime metric is never presented as 7-day.
 * The English `reason` is the stable rule identifier returned by the pure
 * function; the panel renders the localized `settings.duplicateMetric`
 * message instead.
 */
export function applyMetricSlotChange(
  current: LocalSettingsV2['metrics'],
  slot: MetricSlot,
  next: MetricKey | undefined,
): MetricSlotChangeResult {
  const otherKey = slot === 'primary' ? current.secondary : current.primary;

  if (next !== undefined && next === otherKey) {
    return { ok: false, reason: 'This metric is already used in the other slot.' };
  }

  const metrics: LocalSettingsV2['metrics'] = {
    ...(slot === 'primary' && current.secondary !== undefined
      ? { secondary: current.secondary }
      : {}),
    ...(slot === 'secondary' && current.primary !== undefined
      ? { primary: current.primary }
      : {}),
    ...(next !== undefined ? { [slot]: next } : {}),
  };

  return { ok: true, metrics };
}

export interface SettingsPanelProps {
  settings: LocalSettingsV2;
  onChange(metrics: LocalSettingsV2['metrics']): void;
  /** Opinion-translation preference changes (plan Task 7, spec 9.2). */
  onOpinionTranslationChange?(
    update: Partial<LocalSettingsV2['opinionTranslation']>,
  ): void;
}

/**
 * Metric + opinion-translation configuration panel (plan Task 10 Step 2/3 and
 * Task 7 Step 6, spec sections 7.3 and 9.2). Either metric slot can be
 * disabled or replaced; duplicate selection is rejected inline with an error.
 * Option labels reuse the shared formatters so the UI always states the
 * honest 7-day window. The translation controls are independent of the UI
 * locale: enabling and the target language only ever touch
 * `settings.opinionTranslation`.
 */
export function SettingsPanel(props: SettingsPanelProps) {
  const { settings, onChange, onOpinionTranslationChange } = props;
  const { locale, setLocale, translate } = useLocale();
  const [error, setError] = useState(false);

  const handleChange = (slot: MetricSlot, value: string): void => {
    const next = value === 'none' ? undefined : (value as MetricKey);
    const result = applyMetricSlotChange(settings.metrics, slot, next);

    if (!result.ok) {
      setError(true);

      return;
    }

    setError(false);
    onChange(result.metrics);
  };

  const translationEnabled = settings.opinionTranslation.enabled;

  return (
    <section
      className="settings-panel"
      aria-label={translate('settings.metricSettingsAria')}
    >
      <h2 className="settings-title">{translate('settings.metrics')}</h2>
      {SLOTS.map((slot) => {
        const current = settings.metrics[slot];

        return (
          <div key={slot} className="settings-slot">
            <label className="settings-slot-label">
              {slot === 'primary'
                ? translate('settings.primaryMetric')
                : translate('settings.secondaryMetric')}
              <select
                aria-label={
                  slot === 'primary'
                    ? translate('settings.primaryMetric')
                    : translate('settings.secondaryMetric')
                }
                value={current ?? 'none'}
                onChange={(event) => {
                  handleChange(slot, event.target.value);
                }}
              >
                {METRIC_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {translate(METRIC_LABEL_KEYS[key])}
                  </option>
                ))}
                <option value="none">{translate('settings.disabled')}</option>
              </select>
            </label>
          </div>
        );
      })}
      {error && <p className="settings-error">{translate('settings.duplicateMetric')}</p>}

      <section
        className="settings-language"
        aria-label={translate('settings.language')}
      >
        <h3 className="settings-subtitle">{translate('settings.language')}</h3>
        <div
          className="settings-locale-switcher"
          role="group"
          aria-label={translate('language.switch')}
        >
          <button
            type="button"
            className="locale-switcher-button"
            aria-pressed={locale === 'en'}
            onClick={() => {
              setLocale('en');
            }}
          >
            EN
          </button>
          <button
            type="button"
            className="locale-switcher-button"
            aria-pressed={locale === 'zh-CN'}
            onClick={() => {
              setLocale('zh-CN');
            }}
          >
            中文
          </button>
        </div>
      </section>

      {onOpinionTranslationChange !== undefined && (
        <section
          className="settings-translation"
          aria-label={translate('settings.translation')}
        >
          <h3 className="settings-subtitle">{translate('settings.translation')}</h3>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={translationEnabled}
              onChange={(event) => {
                onOpinionTranslationChange({ enabled: event.target.checked });
              }}
            />
            <span>{translate('translation.enable')}</span>
          </label>
          <label className="settings-slot-label">
            {translate('settings.translationTarget')}
            <select
              aria-label={translate('settings.translationTarget')}
              value={settings.opinionTranslation.targetLanguage}
              disabled={!translationEnabled}
              onChange={(event) => {
                onOpinionTranslationChange({
                  targetLanguage: event.target.value as TranslationTarget,
                });
              }}
            >
              <option value="auto">{translate('settings.translationTargetAuto')}</option>
              <option value="zh">{translate('settings.translationTargetZh')}</option>
              <option value="en">{translate('settings.translationTargetEn')}</option>
            </select>
          </label>
        </section>
      )}
    </section>
  );
}
