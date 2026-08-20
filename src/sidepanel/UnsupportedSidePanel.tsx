export function isUnsupportedSidePanelUrl(url: string): boolean {
  try {
    return new URL(url).searchParams.get('unsupported') === 'side-panel';
  } catch {
    return false;
  }
}

export function UnsupportedSidePanel() {
  return (
    <main className="sidepanel-root" aria-labelledby="unsupported-title">
      <section className="popup-state-card">
        <h1 id="unsupported-title">Side Panel unavailable</h1>
        <p>Fomo Live Feed requires Chrome 114 or newer with the Side Panel API enabled.</p>
        <p>Update Chrome, then click the extension action again.</p>
      </section>
    </main>
  );
}
