import { render, screen } from '@testing-library/react';
import { PumpStatusIndicator } from '../../src/sidepanel/PumpStatusIndicator';

vi.mock('../../src/i18n/LocaleProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/i18n/LocaleProvider')>();
  const { translate } = await import('../../src/i18n/catalog');
  return {
    ...actual,
    useLocale: () => ({
      locale: 'en',
      setLocale: () => {},
      translate: (key: Parameters<typeof translate>[1]) => translate('en', key),
    }),
  };
});

describe('PumpStatusIndicator', () => {
  it('shows a compact accessible live status without visible copy', () => {
    const { container } = render(<PumpStatusIndicator status="live" />);

    expect(screen.getByRole('status', { name: 'Pump: Live' })).toHaveAttribute('title', 'Pump: Live');
    expect(container.querySelector('.source-icon-pump')).toBeInTheDocument();
    expect(container.querySelector('.pump-status-dot')).toBeInTheDocument();
  });
});
