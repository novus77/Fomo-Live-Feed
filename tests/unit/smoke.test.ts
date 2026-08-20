import { extensionName } from '../../src/domain/extension';
import { App } from '../../entrypoints/sidepanel/App';

describe('extensionName', () => {
  it('exposes the product name', () => {
    expect(extensionName).toBe('Fomo Live Feed');
  });

  it('exposes the side panel application entrypoint', () => {
    expect(App).toBeTypeOf('function');
  });
});
