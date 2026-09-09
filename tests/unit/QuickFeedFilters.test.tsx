import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import { DEFAULT_FILTERS, type PopupEventFilters } from '../../src/popup/event-query';
import { QuickFeedFilters } from '../../src/sidepanel/QuickFeedFilters';

vi.mock('../../src/i18n/LocaleProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/i18n/LocaleProvider')>();
  const { translate: translateMessage } = await import('../../src/i18n/catalog');
  const useLocale = (): LocaleContextValue => ({
    locale: 'en',
    setLocale: () => {},
    translate: (key, values) => translateMessage('en', key, values),
  });
  return { ...actual, useLocale };
});

function Harness() {
  const [filters, setFilters] = useState<PopupEventFilters>(DEFAULT_FILTERS);
  return <QuickFeedFilters filters={filters} onFiltersChange={setFilters} />;
}

describe('QuickFeedFilters', () => {
  it('keeps buy, sell, and thesis as independent visibility controls', () => {
    render(<Harness />);
    const actions = screen.getByRole('group', { name: 'Quick action filters' });
    const all = within(actions).getByRole('button', { name: 'All actions' });
    const buy = within(actions).getByRole('button', { name: 'Buy' });
    const sell = within(actions).getByRole('button', { name: 'Sell' });

    expect(all).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(buy);
    expect(buy).toHaveAttribute('aria-pressed', 'false');
    expect(sell).toHaveAttribute('aria-pressed', 'true');
    expect(all).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(all);
    expect(buy).toHaveAttribute('aria-pressed', 'true');
    expect(sell).toHaveAttribute('aria-pressed', 'true');
  });

  it('selects one source and renders official source icons', () => {
    const { container } = render(<Harness />);
    const sources = screen.getByRole('group', { name: 'Quick source filters' });
    const all = within(sources).getByRole('button', { name: 'All sources' });
    const pump = within(sources).getByRole('button', { name: /Pump/ });

    fireEvent.click(pump);
    expect(pump).toHaveAttribute('aria-pressed', 'true');
    expect(all).toHaveAttribute('aria-pressed', 'false');
    expect(container.querySelector('.quick-filter-source .source-icon-fomo')).toBeInTheDocument();
    expect(container.querySelector('.quick-filter-source .source-icon-pump')).toBeInTheDocument();
  });
});
