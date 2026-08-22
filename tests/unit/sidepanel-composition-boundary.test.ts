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

    expect(css).toContain('.sidepanel-support-toggle');
    expect(css).toContain('.support-panel');
    expect(css).toContain('.support-group-card');
    expect(css).toContain("[data-theme='light'] .support-panel");
    expect(css).toMatch(
      /\.support-address-value\s*\{[^}]*overflow-wrap:\s*anywhere/s,
    );
    expect(css).not.toMatch(
      /\.support-address-value\s*\{[^}]*text-overflow:\s*ellipsis/s,
    );
  });
});
