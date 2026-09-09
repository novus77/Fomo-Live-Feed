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

  it('requires Chrome 141 for atomic side-panel closure', () => {
    const manifest = config.manifest as { minimum_chrome_version?: string } | undefined;

    expect(typeof manifest).toBe('object');

    if (typeof manifest !== 'object' || manifest === null) {
      throw new Error('manifest must be an object');
    }

    // WXT's UserManifest type is looser than the emitted manifest; read the
    // browser version field via a narrow projection.
    expect(manifest.minimum_chrome_version).toBe('141');
  });

  it('limits host access to the exact Fomo and Pump page origins', () => {
    const manifest = config.manifest as { host_permissions?: string[] } | undefined;

    expect(manifest?.host_permissions).toEqual([
      'https://fomo.family/*',
      'https://www.fomo.family/*',
      'https://pump.fun/*',
      'https://www.pump.fun/*',
    ]);
  });

  it('does not inject into trading pages', () => {
    expect(
      existsSync(resolve('entrypoints/trading-overlay.content/index.ts')),
    ).toBe(false);
  });

  it('adds only the offscreen permission for buy audio playback', () => {
    const manifest = config.manifest as { permissions?: string[] } | undefined;

    expect(manifest?.permissions).toEqual(['storage', 'sidePanel', 'offscreen']);
    expect(manifest?.permissions).not.toContain('notifications');
    expect(manifest?.permissions).not.toContain('tabs');
  });
});
