import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import {
  isUnsupportedSidePanelUrl,
  UnsupportedSidePanel,
} from '../../src/sidepanel/UnsupportedSidePanel';

// Fallback-page strings render through useLocale (EN catalog here); the real
// provider behavior is covered by LocaleProvider.test.tsx.
vi.mock('../../src/i18n/LocaleProvider', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/i18n/LocaleProvider')>();
  const { translate: translateMessage } = await import('../../src/i18n/catalog');

  const useLocale = (): LocaleContextValue => ({
    locale: 'en',
    setLocale: () => {},
    translate: (key, values) => translateMessage('en', key, values),
  });

  return { ...actual, useLocale };
});

describe('UnsupportedSidePanel', () => {
  it('recognizes only the explicit action fallback URL', () => {
    expect(isUnsupportedSidePanelUrl('chrome-extension://id/sidepanel.html?unsupported=side-panel')).toBe(true);
    expect(isUnsupportedSidePanelUrl('chrome-extension://id/sidepanel.html')).toBe(false);
    expect(isUnsupportedSidePanelUrl('not a url')).toBe(false);
  });

  it('shows the required browser version and unavailable reason', () => {
    render(<UnsupportedSidePanel />);
    expect(screen.getByRole('heading', { name: 'Side Panel unavailable' })).toBeInTheDocument();
    expect(screen.getByText(/Chrome 138 or newer/)).toBeInTheDocument();
  });
});
