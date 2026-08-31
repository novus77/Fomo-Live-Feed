import type { LocalSettingsV4, UiTheme } from '../domain/settings';
import type { TranslationTarget } from '../i18n/catalog';
import { useLocale } from '../i18n/LocaleProvider';

export interface SettingsPanelProps {
  settings: LocalSettingsV4;
  /** Opinion-translation preference changes (plan Task 7, spec 9.2). */
  onOpinionTranslationChange?(
    update: Partial<LocalSettingsV4['opinionTranslation']>,
  ): void;
  onThemeChange?(theme: UiTheme): void;
  onNotificationsChange?(
    update: Partial<LocalSettingsV4['notifications']>,
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
  const {
    settings,
    onOpinionTranslationChange,
    onThemeChange,
    onNotificationsChange,
  } = props;
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

      {onThemeChange !== undefined && (
        <section className="settings-theme" aria-label={translate('settings.theme')}>
          <h2 className="settings-title">{translate('settings.theme')}</h2>
          <div className="settings-theme-switcher" role="group" aria-label={translate('settings.theme')}>
            <button type="button" className="theme-switcher-button" aria-label={translate('settings.themeLight')} title={translate('settings.themeLight')} aria-pressed={settings.uiTheme === 'light'} onClick={() => onThemeChange('light')}>
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 4V1h1v3h-1Zm0 19v-3h1v3h-1ZM4.93 5.64 2.8 3.51l.71-.71 2.13 2.13-.71.71Zm13.43 13.43-2.13-2.13.71-.71 2.13 2.13-.71.71ZM4 12v1H1v-1h3Zm19 0v1h-3v-1h3ZM4.93 19.07l-.71-.71 2.13-2.13.71.71-2.13 2.13ZM17.65 6.35l-.71-.71 2.13-2.13.71.71-2.13 2.13ZM12.5 7a5.5 5.5 0 1 1 0 11 5.5 5.5 0 0 1 0-11Z" /></svg>
            </button>
            <button type="button" className="theme-switcher-button" aria-label={translate('settings.themeDark')} title={translate('settings.themeDark')} aria-pressed={settings.uiTheme === 'dark'} onClick={() => onThemeChange('dark')}>
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M20.3 15.7A8.5 8.5 0 0 1 8.3 3.7 9 9 0 1 0 20.3 15.7Z" /></svg>
            </button>
          </div>
        </section>
      )}

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

      {onNotificationsChange !== undefined && (
        <section
          className="settings-notifications"
          aria-label={translate('settings.buySound')}
        >
          <h2 className="settings-title">{translate('settings.buySound')}</h2>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={settings.notifications.soundEnabled}
              onChange={(event) => {
                onNotificationsChange({ soundEnabled: event.target.checked });
              }}
            />
            <span>{translate('settings.buySound')}</span>
          </label>
          <p className="settings-description">
            {translate('settings.buySoundDescription')}
          </p>
        </section>
      )}
    </section>
  );
}
