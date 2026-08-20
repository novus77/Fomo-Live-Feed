import { useState } from 'react';

import { METRIC_KEYS, type LocalSettingsV1, type MetricKey } from '../domain/settings';
import { formatMetricLabel } from '../overlay/format';

const SLOTS = ['primary', 'secondary'] as const;
export type MetricSlot = (typeof SLOTS)[number];

export type MetricSlotChangeResult =
  | { ok: true; metrics: LocalSettingsV1['metrics'] }
  | { ok: false; reason: string };

/**
 * Pure slot-update rule (plan Task 10 Step 2, spec section 5.4):
 * - the same metric cannot fill both slots (duplicate selection is rejected);
 * - selecting Disabled omits the slot's key entirely;
 * - the 7-day labels come from formatMetricLabel so the window is stated
 *   honestly and a lifetime metric is never presented as 7-day.
 */
export function applyMetricSlotChange(
  current: LocalSettingsV1['metrics'],
  slot: MetricSlot,
  next: MetricKey | undefined,
): MetricSlotChangeResult {
  const otherKey = slot === 'primary' ? current.secondary : current.primary;

  if (next !== undefined && next === otherKey) {
    return { ok: false, reason: 'This metric is already used in the other slot.' };
  }

  const metrics: LocalSettingsV1['metrics'] = {
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
  settings: LocalSettingsV1;
  onChange(metrics: LocalSettingsV1['metrics']): void;
}

/**
 * Metric configuration panel (plan Task 10 Step 2/3, spec section 7.3).
 * Either slot can be disabled or replaced; duplicate selection is rejected
 * inline with an error. Option labels reuse the shared formatters so the
 * UI always states the honest 7-day window.
 */
export function SettingsPanel(props: SettingsPanelProps) {
  const { settings, onChange } = props;
  const [error, setError] = useState<string | null>(null);

  const handleChange = (slot: MetricSlot, value: string): void => {
    const next = value === 'none' ? undefined : (value as MetricKey);
    const result = applyMetricSlotChange(settings.metrics, slot, next);

    if (!result.ok) {
      setError(result.reason);

      return;
    }

    setError(null);
    onChange(result.metrics);
  };

  return (
    <section className="settings-panel" aria-label="Metric settings">
      <h2 className="settings-title">Metrics</h2>
      {SLOTS.map((slot) => {
        const current = settings.metrics[slot];

        return (
          <div key={slot} className="settings-slot">
            <label className="settings-slot-label">
              {slot === 'primary' ? 'Primary metric' : 'Secondary metric'}
              <select
                aria-label={slot === 'primary' ? 'Primary metric' : 'Secondary metric'}
                value={current ?? 'none'}
                onChange={(event) => {
                  handleChange(slot, event.target.value);
                }}
              >
                {METRIC_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {formatMetricLabel(key)}
                  </option>
                ))}
                <option value="none">Disabled</option>
              </select>
            </label>
          </div>
        );
      })}
      {error !== null && <p className="settings-error">{error}</p>}
    </section>
  );
}
