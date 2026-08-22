import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import { ConnectionIndicator } from '../../src/sidepanel/ConnectionIndicator';

// Connection labels render through useLocale (EN catalog here); the real
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

describe('ConnectionIndicator', () => {
  it.each([
    ['loading', 'Checking…'],
    ['connected', 'Connected'],
    ['reconnecting', 'Reconnecting'],
    ['offline', 'Offline'],
    ['login-required', 'Login required'],
  ] as const)('renders %s as a permanent status', (state, label) => {
    render(<ConnectionIndicator state={state} />);

    expect(screen.getByRole('status')).toHaveTextContent(label);
  });
});
