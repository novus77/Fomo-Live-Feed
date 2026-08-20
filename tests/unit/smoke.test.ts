import { extensionName } from '../../src/domain/extension';

describe('extensionName', () => {
  it('exposes the product name', () => {
    expect(extensionName).toBe('Fomo Live Feed');
  });
});
