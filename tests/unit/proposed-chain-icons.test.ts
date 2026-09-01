import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const asset = (name: string): string =>
  readFileSync(`icon-proposals/${name}.svg`, 'utf8');

describe('proposed chain icon vectors', () => {
  it.each([
    ['bsc', '#F0B90B'],
    ['robinhood', '#C6FF00'],
  ])(
    '%s is a transparent standalone vector using the approved color',
    (name, color) => {
      const svg = asset(name);

      expect(svg).toContain('viewBox="0 0 32 32"');
      expect(svg).toContain(color);
      expect(svg).not.toMatch(/<(image|script)\b/i);
      expect(svg).not.toMatch(
        /<rect[^>]+(?:width="32"|width="100%")/i,
      );
    },
  );
});
