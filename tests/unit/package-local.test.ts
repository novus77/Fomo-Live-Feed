import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  artifactName,
  assertAllowedRelativePaths,
  parseManifest,
  packageLocalRelease,
  renderGuide,
  sha256File,
} from '../../scripts/package-local.mjs';

describe('local release packaging', () => {
  it('uses the package version in the Chrome artifact name', () => {
    expect(artifactName('0.1.0')).toBe('Fomo-Live-Feed-v0.1.0-chrome.zip');
  });

  it('renders an offline recipient guide without developer prerequisites', () => {
    const guide = renderGuide({
      version: '0.1.0',
      builtAt: '2026-08-22T12:00:00.000Z',
    });

    expect(guide).toContain('chrome://extensions');
    expect(guide).toContain('Windows');
    expect(guide).toContain('macOS');
    expect(guide).toContain('全部解压缩');
    expect(guide).toContain('连按两下');
    expect(guide).toContain('加载已解压的扩展程序');
    expect(guide).toContain('https://fomo.family/');
    expect(guide).toContain('DexScreener');
    expect(guide).toContain('GMGN');
    expect(guide).toContain('刷新一次 Fomo 页面');
    expect(guide).toContain('Chrome 138');
    expect(guide).toContain('不连接钱包');
    expect(guide).toContain('0.1.0');
    expect(guide).toContain('2026-08-22T12:00:00.000Z');
    expect(guide).not.toMatch(/Node\.js|pnpm|git clone|\/Users\//);
    expect(guide).not.toMatch(/<script|https?:\/\/[^<]*\.(?:js|css)/i);
  });

  it('accepts only a manifest matching the package version', () => {
    expect(
      parseManifest('{"manifest_version":3,"version":"0.1.0"}', '0.1.0'),
    ).toMatchObject({ manifest_version: 3, version: '0.1.0' });
    expect(() =>
      parseManifest('{"manifest_version":3,"version":"0.1.1"}', '0.1.0'),
    ).toThrow(
      'manifest version 0.1.1 does not match package version 0.1.0',
    );
    expect(() => parseManifest('not json', '0.1.0')).toThrow(
      'invalid manifest.json',
    );
  });

  it('rejects development paths from release staging', () => {
    expect(() =>
      assertAllowedRelativePaths(['manifest.json', 'icons/icon-16.png']),
    ).not.toThrow();

    for (const path of [
      '__MACOSX/._manifest.json',
      'content-scripts\\fomo-bridge.js',
      'node_modules/react/index.js',
      '.git/config',
      '.pnpm-store/index.json',
      '.output/chrome-mv3/manifest.json',
      'tests/unit/smoke.test.ts',
      'src/background.ts',
      '.env',
    ]) {
      expect(() =>
        assertAllowedRelativePaths(['manifest.json', path]),
      ).toThrow(path);
    }
  });

  it('writes a standard SHA-256 digest for an artifact', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'fomo-package-test-'));
    const artifact = join(directory, 'release.zip');
    writeFileSync(artifact, 'release-bytes');

    const digest = await sha256File(artifact);

    expect(digest).toBe(
      'a7240e889d036c5a4a5538438f3863fc18085e08ff537f7b89b2295937457d8a',
    );
  });

  it('creates a root-layout ZIP, guide, and matching checksum', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fomo-local-release-'));
    const output = join(root, '.output', 'chrome-mv3');
    mkdirSync(join(output, 'icons'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'fomo-live-feed', version: '0.1.0' }),
    );
    writeFileSync(
      join(output, 'manifest.json'),
      JSON.stringify({ manifest_version: 3, version: '0.1.0' }),
    );
    writeFileSync(join(output, 'sidepanel.html'), '<!doctype html>');
    writeFileSync(join(output, 'background.js'), 'export {};');
    writeFileSync(join(output, 'icons', 'icon-16.png'), 'icon');

    const result = await packageLocalRelease({
      projectRoot: root,
      builtAt: '2026-08-22T12:00:00.000Z',
    });

    expect(result.artifactPath).toBe(
      join(
        root,
        '.output',
        'releases',
        'Fomo-Live-Feed-v0.1.0-chrome.zip',
      ),
    );
    const entries = execFileSync('unzip', ['-Z1', result.artifactPath])
      .toString('utf8')
      .trim()
      .split('\n');
    expect(entries).toContain('manifest.json');
    expect(entries).toContain('START-HERE.html');
    expect(entries).not.toContain('chrome-mv3/manifest.json');
    expect(readFileSync(result.checksumPath, 'utf8')).toBe(
      `${await sha256File(result.artifactPath)}  Fomo-Live-Feed-v0.1.0-chrome.zip\n`,
    );
  });

  it('keeps recipient installation independent from the development checkout', () => {
    const readme = readFileSync(join(process.cwd(), 'README.md'), 'utf8');
    const manual = readFileSync(
      join(process.cwd(), 'docs', 'manual-testing.zh-CN.md'),
      'utf8',
    );

    expect(readme).toContain('Fomo-Live-Feed-v<version>-chrome.zip');
    expect(readme).toContain('Load unpacked');
    expect(manual).toContain('package:local');
    expect(manual).not.toContain('.worktrees/codex-fomo-live-feed');
    expect(manual).not.toContain(
      '右上角只有“刷新”和“设置”两个图标按钮',
    );
  });
});
