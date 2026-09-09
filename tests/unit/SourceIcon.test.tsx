import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SourceIcon } from '../../src/sidepanel/SourceIcon';

describe('SourceIcon', () => {
  it.each([
    ['fomo', '/sources/fomo.svg', 'Fomo'],
    ['pump', '/sources/pump.png', 'Pump'],
  ] as const)('maps %s to its bundled official asset', (source, src, label) => {
    render(<SourceIcon source={source} />);

    expect(screen.getByRole('img', { name: label })).toHaveAttribute('src', src);
    expect(existsSync(resolve(process.cwd(), `public${src}`))).toBe(true);
  });
});
