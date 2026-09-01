import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('entrypoints/sidepanel/sidepanel.css', 'utf8');

describe('side panel style contract', () => {
  it('defines both theme foundations and every event accent', () => {
    expect(css).toContain(".sidepanel-root[data-theme='light']");
    expect(css).toContain('--ui-canvas: #f4f6f9');

    for (const token of [
      '--event-buy',
      '--event-sell',
      '--event-thesis',
      '--event-transfer',
      '--event-withdraw',
    ]) {
      expect(css).toContain(token);
    }
  });

  it('removes spatial motion for reduced-motion users', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(css).toContain('animation-duration: 0.01ms');
    expect(css).toContain('transform: none !important');
  });

  it('uses one-shot motion only', () => {
    expect(css).not.toMatch(/animation:[^;]*(?:infinite|alternate)/);
    expect(css).toContain('animation: event-arrival 620ms');
    expect(css).toContain('animation: refresh-spin 520ms');
  });
});
