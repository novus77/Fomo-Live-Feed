import { useLocale } from '../i18n/LocaleProvider';

export function isUnsupportedSidePanelUrl(url: string): boolean {
  try {
    return new URL(url).searchParams.get('unsupported') === 'side-panel';
  } catch {
    return false;
  }
}

export function UnsupportedSidePanel() {
  const { translate } = useLocale();

  return (
    <main className="sidepanel-root" aria-labelledby="unsupported-title">
      <section className="popup-state-card">
        <h1 id="unsupported-title">{translate('unsupported.title')}</h1>
        <p>{translate('unsupported.body')}</p>
        <p>{translate('unsupported.hint')}</p>
      </section>
    </main>
  );
}
