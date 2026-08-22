import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('side panel composition boundary', () => {
  it('owns its component implementation instead of re-exporting PopupApp', () => {
    const source = readFileSync('src/sidepanel/SidePanelApp.tsx', 'utf8');

    expect(source).toContain('export function SidePanelApp');
    expect(source).not.toMatch(/PopupApp/);
  });
});
