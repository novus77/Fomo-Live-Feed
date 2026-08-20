interface SidePanelApiLike {
  setPanelBehavior?(options: {
    openPanelOnActionClick: boolean;
  }): Promise<void>;
}

interface ChromeWithOptionalSidePanel {
  sidePanel?: SidePanelApiLike;
}

export type ConfigureActionSidePanelResult =
  | { supported: true }
  | { supported: false };

export async function configureActionSidePanel(
  chromeApi: ChromeWithOptionalSidePanel = (
    globalThis as typeof globalThis & { chrome?: ChromeWithOptionalSidePanel }
  ).chrome ?? {},
): Promise<ConfigureActionSidePanelResult> {
  if (typeof chromeApi.sidePanel?.setPanelBehavior !== 'function') {
    return { supported: false };
  }

  await chromeApi.sidePanel.setPanelBehavior({
    openPanelOnActionClick: true,
  });

  return { supported: true };
}
