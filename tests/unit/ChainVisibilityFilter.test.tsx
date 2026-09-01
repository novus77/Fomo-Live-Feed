import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import { FILTERABLE_CHAINS } from '../../src/sidepanel/chain-visibility';
import { ChainVisibilityFilter } from '../../src/sidepanel/ChainVisibilityFilter';

vi.mock('../../src/i18n/LocaleProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/i18n/LocaleProvider')>();
  const { translate } = await import('../../src/i18n/catalog');
  const useLocale = (): LocaleContextValue => ({
    locale: 'en',
    setLocale: () => {},
    translate: (key, values) => translate('en', key, values),
  });

  return { ...actual, useLocale };
});

describe('ChainVisibilityFilter', () => {
  it('renders the approved six labels and toggles one chain', () => {
    const onChange = vi.fn();

    render(
      <ChainVisibilityFilter
        visibleChains={FILTERABLE_CHAINS}
        onChange={onChange}
      />,
    );

    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(6);
    expect(screen.getByRole('button', { name: 'Solana', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Robinhood', pressed: true })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ethereum', pressed: true })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Base' }));
    expect(onChange).toHaveBeenCalledWith([
      'bsc',
      'solana',
      'robinhood',
      'ethereum',
      'x-layer',
    ]);
  });

  it('shows the approved icon beside every selectable chain label', () => {
    const { container } = render(
      <ChainVisibilityFilter
        visibleChains={[...FILTERABLE_CHAINS]}
        onChange={vi.fn()}
      />,
    );

    expect(container.querySelectorAll('.feed-filter-chain .chain-icon')).toHaveLength(6);
    expect(screen.getByRole('button', { name: 'Robinhood' })).toHaveTextContent('Robinhood');
  });

  it('supports deselect-all and select-all', () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ChainVisibilityFilter
        visibleChains={FILTERABLE_CHAINS}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }));
    expect(onChange).toHaveBeenLastCalledWith([]);

    rerender(<ChainVisibilityFilter visibleChains={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(onChange).toHaveBeenLastCalledWith([...FILTERABLE_CHAINS]);
  });
});
