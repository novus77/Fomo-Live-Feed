import {
  DEFAULT_FINANCIAL_DISPLAY,
  FINANCIAL_FONT_SIZE_MAX,
  FINANCIAL_FONT_SIZE_MIN,
  type FinancialDisplaySettings as FinancialDisplayValue,
  type LocalSettingsUpdate,
  type UiTheme,
} from '../domain/settings';
import { useLocale } from '../i18n/LocaleProvider';
import type { MessageKey } from '../i18n/catalog';

type FinancialRole = keyof FinancialDisplayValue;
type FinancialDisplayUpdate = NonNullable<LocalSettingsUpdate['financialDisplay']>;

export interface FinancialDisplaySettingsProps {
  value: FinancialDisplayValue;
  theme: UiTheme;
  onChange(update: FinancialDisplayUpdate): void;
}

const ROLE_LABELS: Record<FinancialRole, MessageKey> = {
  buyAmount: 'settings.buyAmount',
  sellAmount: 'settings.sellAmount',
  marketCap: 'settings.marketCap',
};

const ROLE_SAMPLES: Record<FinancialRole, string> = {
  buyAmount: '$1.25K',
  sellAmount: '$860',
  marketCap: 'MC: $4.2M',
};

const PRESETS = [
  { size: 11, label: 'settings.presetSmall' },
  { size: 13, label: 'settings.presetStandard' },
  { size: 16, label: 'settings.presetLarge' },
  { size: 18, label: 'settings.presetExtraLarge' },
] as const;

const SWATCHES = ['#18D79C', '#FF6577', '#7EA7FF', '#A6B3C8'] as const;

function hasLowContrast(color: string, theme: UiTheme): boolean {
  if (color === 'theme') return false;
  const value = color.slice(1);
  const channels = [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16));
  const [red = 0, green = 0, blue = 0] = channels;
  const luminance = (red * 299 + green * 587 + blue * 114) / 255000;
  return theme === 'dark' ? luminance < 0.32 : luminance > 0.78;
}

export function FinancialDisplaySettings({
  value,
  theme,
  onChange,
}: FinancialDisplaySettingsProps) {
  const { translate } = useLocale();

  return (
    <div className="financial-display-settings">
      {(Object.keys(ROLE_LABELS) as FinancialRole[]).map((role) => {
        const style = value[role];
        const roleLabel = translate(ROLE_LABELS[role]);
        const customColor = style.color === 'theme' ? '#a6b3c8' : style.color.toLowerCase();

        return (
          <fieldset key={role} className={`financial-role financial-role-${role}`}>
            <legend>{roleLabel}</legend>
            <div className="financial-role-header">
              <span
                className="financial-role-sample"
                style={{
                  fontSize: `${style.fontSizePx}px`,
                  color: style.color === 'theme' ? undefined : style.color,
                }}
              >
                {ROLE_SAMPLES[role]}
              </span>
              <button
                type="button"
                className="financial-reset-role"
                aria-label={translate('settings.resetRole', { role: roleLabel.toLowerCase() })}
                onClick={() => onChange({ [role]: DEFAULT_FINANCIAL_DISPLAY[role] })}
              >
                ↺
              </button>
            </div>
            <div className="financial-size-presets">
              {PRESETS.map((preset) => (
                <button
                  key={preset.size}
                  type="button"
                  aria-label={translate(preset.label, { role: roleLabel })}
                  aria-pressed={style.fontSizePx === preset.size}
                  onClick={() => onChange({ [role]: { fontSizePx: preset.size } })}
                >
                  {preset.size}
                </button>
              ))}
            </div>
            <label className="financial-size-control">
              <span>{style.fontSizePx}px</span>
              <input
                type="range"
                min={FINANCIAL_FONT_SIZE_MIN}
                max={FINANCIAL_FONT_SIZE_MAX}
                value={style.fontSizePx}
                aria-label={translate('settings.fontSize', { role: roleLabel })}
                onChange={(event) => onChange({
                  [role]: { fontSizePx: Number(event.target.value) },
                })}
              />
            </label>
            <div className="financial-color-controls">
              <button
                type="button"
                className="financial-theme-color"
                aria-label={translate('settings.themeColor', { role: roleLabel })}
                aria-pressed={style.color === 'theme'}
                onClick={() => onChange({ [role]: { color: 'theme' } })}
              >
                A
              </button>
              {SWATCHES.map((color) => (
                <button
                  key={color}
                  type="button"
                  className="financial-color-swatch"
                  aria-label={`${roleLabel} ${color}`}
                  aria-pressed={style.color === color}
                  style={{ backgroundColor: color }}
                  onClick={() => onChange({ [role]: { color } })}
                />
              ))}
              <input
                type="color"
                value={customColor}
                aria-label={translate('settings.customColor', { role: roleLabel })}
                onChange={(event) => onChange({
                  [role]: { color: event.target.value.toUpperCase() as `#${string}` },
                })}
              />
            </div>
            {hasLowContrast(style.color, theme) && (
              <span className="financial-contrast-warning">
                {translate('settings.contrastWarning')}
              </span>
            )}
          </fieldset>
        );
      })}
      <button
        type="button"
        className="financial-reset-all"
        aria-label={translate('settings.resetFinancialDisplay')}
        onClick={() => onChange(DEFAULT_FINANCIAL_DISPLAY)}
      >
        {translate('settings.resetFinancialDisplay')}
      </button>
    </div>
  );
}
