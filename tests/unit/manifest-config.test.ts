import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import config from '../../wxt.config';

describe('extension manifest configuration', () => {
  it('declares an action without a popup', () => {
    const manifest = config.manifest;

    expect(manifest).toBeTypeOf('object');
    expect(manifest).toHaveProperty('action');
    expect(manifest).not.toHaveProperty('action.default_popup');
  });

  it('requires Chrome 138 for the on-device translation API', () => {
    const manifest = config.manifest as { minimum_chrome_version?: string } | undefined;

    expect(typeof manifest).toBe('object');

    if (typeof manifest !== 'object' || manifest === null) {
      throw new Error('manifest must be an object');
    }

    // WXT's UserManifest type is looser than the emitted manifest; read the
    // browser version field via a narrow projection.
    expect(manifest.minimum_chrome_version).toBe('138');
  });

  it('does not inject into or request access to trading pages', () => {
    const manifest = config.manifest as { host_permissions?: string[] } | undefined;

    expect(manifest?.host_permissions).not.toContain('https://dexscreener.com/*');
    expect(manifest?.host_permissions).not.toContain('https://gmgn.ai/*');
    expect(
      existsSync(resolve('entrypoints/trading-overlay.content/index.ts')),
    ).toBe(false);
  });
});
