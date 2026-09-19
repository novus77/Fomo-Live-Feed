import { useMemo } from 'react';

import { FloatingSurfaceHost } from '../../src/floatpanel/FloatingSurfaceHost';
import { createPanelDependencies } from '../../src/floatpanel/create-panel-dependencies';
import { LocaleProvider } from '../../src/i18n/LocaleProvider';
import { mutateSettings } from '../../src/popup/popup-io';

import '../sidepanel/sidepanel.css';
import './floatpanel.css';

/** Activation and recovery host for the always-on-top Document PiP feed. */
export function App() {
  const deps = useMemo(() => createPanelDependencies('floatpanel'), []);
  const preferences = deps.preferences;

  if (preferences === undefined) {
    throw new Error('Floating surface requires shared preferences');
  }
  const localePreferences = useMemo(() => ({
    getSettings: () => preferences.getSettings(),
    updateSettings: (update: Parameters<typeof preferences.updateSettings>[0]) =>
      mutateSettings(deps.runtime, update),
  }), [deps.runtime, preferences]);

  return (
    <LocaleProvider
      preferences={localePreferences}
      onChanged={deps.storage.onChanged}
    >
      <FloatingSurfaceHost deps={deps} />
    </LocaleProvider>
  );
}
