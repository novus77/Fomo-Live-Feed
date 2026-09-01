import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('side panel composition boundary', () => {
  it('owns its component implementation instead of re-exporting PopupApp', () => {
    const source = readFileSync('src/sidepanel/SidePanelApp.tsx', 'utf8');

    expect(source).toContain('export function SidePanelApp');
    expect(source).not.toMatch(/PopupApp/);
  });

  it('styles the support panel in both themes without truncating addresses', () => {
    const css = readFileSync('entrypoints/sidepanel/sidepanel.css', 'utf8');
    const supportSource = readFileSync(
      'src/sidepanel/SupportPanel.tsx',
      'utf8',
    );

    expect(css).toContain('.sidepanel-support-toggle');
    expect(css).toContain('.support-panel');
    expect(css).toContain('.support-group-card');
    expect(supportSource).toContain('support-panel utility-panel');
    expect(css).toContain(".sidepanel-root[data-theme='light']");
    expect(css).toContain('--ui-raised: #ffffff');
    expect(css).toMatch(
      /\.utility-panel,\s*\.utility-diagnostics\s*\{[^}]*background:\s*var\(--ui-raised\)/s,
    );
    expect(css).toMatch(
      /\.support-address-value\s*\{[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(css).not.toMatch(
      /\.support-address-value\s*\{[^}]*text-overflow:\s*ellipsis/s,
    );
  });
});
