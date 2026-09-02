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

  it('keeps the token symbol and chain together without stretching the link', () => {
    expect(css).toMatch(
      /\.event-token-symbol\s*\{[^}]*flex:\s*0 1 auto/s,
    );
    expect(css).toMatch(
      /\.event-token-link\s*\{[^}]*text-align:\s*left/s,
    );
  });

  it('keeps inline trader notes on the compact identity row', () => {
    expect(css).toMatch(
      /\.event-trader-primary\s*\{[^}]*white-space:\s*nowrap/s,
    );
    expect(css).toMatch(
      /\.trader-note-chip[^}]*text-overflow:\s*ellipsis/s,
    );
    expect(css).toMatch(
      /\.trader-note-input\s*\{[^}]*max-width:\s*120px/s,
    );
    expect(css).toMatch(/\.event-time\s*\{[^}]*flex:\s*none/s);
  });
});
