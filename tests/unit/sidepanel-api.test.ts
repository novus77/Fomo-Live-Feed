import { configureActionSidePanel } from '../../src/sidepanel/sidepanel-api';

describe('configureActionSidePanel', () => {
  it('configures the extension action to open the side panel', async () => {
    const calls: Array<{ openPanelOnActionClick: boolean }> = [];

    const result = await configureActionSidePanel({
      sidePanel: {
        setPanelBehavior: async (options) => {
          calls.push(options);
        },
      },
    });

    expect(result).toEqual({ supported: true });
    expect(calls).toEqual([{ openPanelOnActionClick: true }]);
  });

  it('returns unsupported when the side panel API is unavailable', async () => {
    await expect(configureActionSidePanel({})).resolves.toEqual({ supported: false });
  });

  it('returns unsupported when setPanelBehavior is unavailable', async () => {
    await expect(
      configureActionSidePanel({ sidePanel: {} }),
    ).resolves.toEqual({ supported: false });
  });
});
