import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('entrypoints/sidepanel/sidepanel.css', 'utf8');

function hexFromDeclaration(block: string, property: string): string {
  const match = block.match(new RegExp(`${property}:\\s*(#[0-9a-f]{6})`, 'i'));

  if (match?.[1] === undefined) {
    throw new Error(`Missing ${property} color declaration`);
  }

  return match[1];
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * (channels[0] ?? 0)
    + 0.7152 * (channels[1] ?? 0)
    + 0.0722 * (channels[2] ?? 0);
}

function contrastRatio(foreground: string, background: string): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

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

  it('implements the approved terminal shell and three-row card geometry', () => {
    expect(css).toMatch(/\.quick-feed-filters\s*\{[^}]*overflow-x:\s*auto/s);
    expect(css).toMatch(/\.event-card-header\s*\{[^}]*grid-template-columns:/s);
    expect(css).toMatch(/\.event-avatar-wrap\s*\{[^}]*position:\s*relative/s);
    expect(css).toMatch(/\.event-source-badge-avatar\s*\{[^}]*position:\s*absolute/s);
    expect(css).toMatch(/\.event-action-line\s*\{[^}]*grid-template-columns:/s);
    expect(css).toMatch(/\.copyable-address\s*\{[^}]*grid-template-columns:/s);
  });

  it('keeps thesis status text at WCAG AA contrast on dark event cards', () => {
    const darkTheme = css.match(/\.sidepanel-root\s*\{([^}]*)\}/s)?.[1] ?? '';
    const statusColor = hexFromDeclaration(darkTheme, '--ui-text-muted');
    const cardBackground = hexFromDeclaration(darkTheme, '--ui-raised');

    expect(contrastRatio(statusColor, cardBackground)).toBeGreaterThanOrEqual(4.5);
    expect(css).toMatch(
      /\.event-thesis-status\s*\{[^}]*color:\s*var\(--ui-text-muted\)/s,
    );
  });
});
