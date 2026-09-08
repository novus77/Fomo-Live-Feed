import {
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';

import type { DisplayMode, LocalSettingsUpdate, LocalSettingsV6, UiTheme } from '../domain/settings';
import type { TranslationTarget } from '../i18n/catalog';
import { useLocale } from '../i18n/LocaleProvider';
import { FinancialDisplaySettings } from './FinancialDisplaySettings';

export interface SettingsPanelProps {
  settings: LocalSettingsV6;
  /** Opinion-translation preference changes (plan Task 7, spec 9.2). */
  onOpinionTranslationChange?(
    update: Partial<LocalSettingsV6['opinionTranslation']>,
  ): void;
  onThemeChange?(theme: UiTheme): void;
  onNotificationsChange?(
    update: Partial<LocalSettingsV6['notifications']>,
  ): void;
  onFinancialDisplayChange?(
    update: NonNullable<LocalSettingsUpdate['financialDisplay']>,
  ): void;
  /** Display-mode (side panel vs single floating window) changes. */
  onDisplayModeChange?(mode: DisplayMode): void;
  displayModeSwitching?: boolean;
  displayModeSwitchError?: boolean;
  advancedContent?: ReactNode;
}

type SettingsCategory = 'display' | 'alerts' | 'advanced';

const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  'display',
  'alerts',
  'advanced',
];

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
    onFinancialDisplayChange,
    onDisplayModeChange,
    displayModeSwitching = false,
    displayModeSwitchError = false,
    advancedContent,
  } = props;
  const { locale, setLocale, translate } = useLocale();
  const [activeCategory, setActiveCategory] = useState<SettingsCategory>('display');
  const tabsId = useId();
  const tabRefs = useRef<Record<SettingsCategory, HTMLButtonElement | null>>({
    display: null,
    alerts: null,
    advanced: null,
  });

  const translationEnabled = settings.opinionTranslation.enabled;

  const tabId = (category: SettingsCategory) => `${tabsId}-${category}-tab`;
  const panelId = (category: SettingsCategory) => `${tabsId}-${category}-panel`;
  const activateCategory = (category: SettingsCategory) => {
    setActiveCategory(category);
    tabRefs.current[category]?.focus();
  };
  const handleCategoryKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    category: SettingsCategory,
  ) => {
    const currentIndex = SETTINGS_CATEGORIES.indexOf(category);
    let nextIndex: number;

    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (currentIndex + 1) % SETTINGS_CATEGORIES.length;
        break;
      case 'ArrowLeft':
        nextIndex = (currentIndex - 1 + SETTINGS_CATEGORIES.length) % SETTINGS_CATEGORIES.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = SETTINGS_CATEGORIES.length - 1;
        break;
      default:
        return;
    }

    event.preventDefault();
    const nextCategory = SETTINGS_CATEGORIES[nextIndex];
    if (nextCategory !== undefined) {
      activateCategory(nextCategory);
    }
  };

  return (
    <section
      className="settings-panel utility-panel"
      aria-label={translate('settings.title')}
    >
      <div
        className="settings-category-tabs"
        role="tablist"
        aria-label={translate('settings.title')}
        aria-orientation="horizontal"
      >
        <button
          type="button"
          role="tab"
          id={tabId('display')}
          aria-controls={panelId('display')}
          aria-selected={activeCategory === 'display'}
          tabIndex={activeCategory === 'display' ? 0 : -1}
          ref={(element) => {
            tabRefs.current.display = element;
          }}
          onClick={() => setActiveCategory('display')}
          onKeyDown={(event) => handleCategoryKeyDown(event, 'display')}
        >
          {translate('settings.categoryDisplay')}
        </button>
        <button
          type="button"
          role="tab"
          id={tabId('alerts')}
          aria-controls={panelId('alerts')}
          aria-selected={activeCategory === 'alerts'}
          tabIndex={activeCategory === 'alerts' ? 0 : -1}
          ref={(element) => {
            tabRefs.current.alerts = element;
          }}
          onClick={() => setActiveCategory('alerts')}
          onKeyDown={(event) => handleCategoryKeyDown(event, 'alerts')}
        >
          {translate('settings.categoryAlerts')}
        </button>
        <button
          type="button"
          role="tab"
          id={tabId('advanced')}
          aria-controls={panelId('advanced')}
          aria-selected={activeCategory === 'advanced'}
          tabIndex={activeCategory === 'advanced' ? 0 : -1}
          ref={(element) => {
            tabRefs.current.advanced = element;
          }}
          onClick={() => setActiveCategory('advanced')}
          onKeyDown={(event) => handleCategoryKeyDown(event, 'advanced')}
        >
          {translate('settings.categoryAdvanced')}
        </button>
      </div>

      <div
        id={panelId('display')}
        className="settings-category-panel"
        role="tabpanel"
        aria-labelledby={tabId('display')}
        hidden={activeCategory !== 'display'}
      >
      {activeCategory === 'display' && <section
        className="settings-language settings-section"
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
      </section>}

      {activeCategory === 'display' && onThemeChange !== undefined && (
        <section className="settings-theme settings-section" aria-label={translate('settings.theme')}>
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

      {activeCategory === 'display' && onDisplayModeChange !== undefined && (
        <section
          className="settings-display-mode settings-section"
          aria-label={translate('settings.displayMode')}
        >
          <h2 className="settings-title">{translate('settings.displayMode')}</h2>
          <div
            className="settings-display-mode-switcher"
            role="group"
            aria-label={translate('settings.displayMode')}
          >
            <button
              type="button"
              className="display-mode-switcher-button"
              aria-pressed={settings.displayMode === 'sidepanel'}
              disabled={displayModeSwitching}
              onClick={() => {
                onDisplayModeChange('sidepanel');
              }}
            >
              {displayModeSwitching && settings.displayMode !== 'sidepanel'
                ? translate('settings.displayModeSwitching')
                : translate('settings.displayModeSidePanel')}
            </button>
            <button
              type="button"
              className="display-mode-switcher-button"
              aria-pressed={settings.displayMode === 'floating'}
              disabled={displayModeSwitching}
              onClick={() => {
                onDisplayModeChange('floating');
              }}
            >
              {displayModeSwitching && settings.displayMode !== 'floating'
                ? translate('settings.displayModeSwitching')
                : translate('settings.displayModeFloating')}
            </button>
          </div>
          <p className="settings-description">
            {settings.displayMode === 'floating'
              ? translate('settings.displayModeFloatingHint')
              : translate('settings.displayModeSidePanelHint')}
          </p>
          {displayModeSwitchError && (
            <p className="settings-description" role="alert">
              {translate('settings.displayModeSwitchError')}
            </p>
          )}
        </section>
      )}

      {activeCategory === 'display' && onFinancialDisplayChange !== undefined && (
        <section
          className="settings-financial-display settings-section"
          aria-label={translate('settings.financialDisplay')}
        >
          <h2 className="settings-title">{translate('settings.financialDisplay')}</h2>
          <FinancialDisplaySettings
            value={settings.financialDisplay}
            theme={settings.uiTheme}
            onChange={onFinancialDisplayChange}
          />
        </section>
      )}
      </div>

      <div
        id={panelId('alerts')}
        className="settings-category-panel"
        role="tabpanel"
        aria-labelledby={tabId('alerts')}
        hidden={activeCategory !== 'alerts'}
      >
      {activeCategory === 'alerts' && onOpinionTranslationChange !== undefined && (
        <section
          className="settings-translation settings-section"
          aria-label={translate('settings.translation')}
        >
          <h2 className="settings-title">{translate('settings.translation')}</h2>
          <label className="settings-toggle settings-toggle-row">
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

      {activeCategory === 'alerts' && onNotificationsChange !== undefined && (
        <section
          className="settings-notifications settings-section"
          aria-label={translate('settings.buySound')}
        >
          <h2 className="settings-title">{translate('settings.buySound')}</h2>
          <label className="settings-toggle settings-toggle-row">
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
      </div>

      <div
        id={panelId('advanced')}
        className="settings-category-panel"
        role="tabpanel"
        aria-labelledby={tabId('advanced')}
        hidden={activeCategory !== 'advanced'}
      >
        {activeCategory === 'advanced' && advancedContent}
      </div>
    </section>
  );
}
