import type { LocalSettingsV3 } from '../domain/settings';
import type { TranslationTarget } from '../i18n/catalog';
import { useLocale } from '../i18n/LocaleProvider';

export interface SettingsPanelProps {
  settings: LocalSettingsV3;
  /** Opinion-translation preference changes (plan Task 7, spec 9.2). */
  onOpinionTranslationChange?(
    update: Partial<LocalSettingsV3['opinionTranslation']>,
  ): void;
}

/**
 * Locale + opinion-translation configuration panel (plan Task 10 Step 2/3 and
 * Task 7 Step 6, spec sections 7.3 and 9.2). The translation controls are
 * independent of the UI locale: enabling and the target language only ever
 * touch `settings.opinionTranslation`. The EN / 中文 UI-language switch is the
 * only locale control and lives here, not in the main feed view.
 */
export function SettingsPanel(props: SettingsPanelProps) {
  const { settings, onOpinionTranslationChange } = props;
  const { locale, setLocale, translate } = useLocale();

  const translationEnabled = settings.opinionTranslation.enabled;

  return (
    <section
      className="settings-panel"
      aria-label={translate('settings.title')}
    >
      <section
        className="settings-language"
        aria-label={translate('settings.language')}
      >
        <h2 className="settings-title">{translate('settings.language')}</h2>
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
          <h2 className="settings-title">{translate('settings.translation')}</h2>
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
