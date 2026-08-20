import config from '../../wxt.config';

describe('extension manifest configuration', () => {
  it('declares an action without a popup', () => {
    const manifest = config.manifest;

    expect(manifest).toBeTypeOf('object');
    expect(manifest).toHaveProperty('action');
    expect(manifest).not.toHaveProperty('action.default_popup');
  });
});
