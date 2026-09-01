import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import { DEFAULT_FILTERS, type PopupEventFilters } from '../../src/popup/event-query';
import { FeedFilterPopover } from '../../src/sidepanel/FeedFilterPopover';

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

function StatefulPopover() {
  const [filters, setFilters] = useState<PopupEventFilters>({
    ...DEFAULT_FILTERS,
    visibleActions: { ...DEFAULT_FILTERS.visibleActions },
  });
  const [open, setOpen] = useState(false);

  return (
    <FeedFilterPopover
      filters={filters}
      open={open}
      onOpenChange={setOpen}
      onFiltersChange={setFilters}
    />
  );
}

describe('FeedFilterPopover', () => {
  it('uses an icon-only accessible funnel trigger and independent action toggles', () => {
    render(<StatefulPopover />);

    const trigger = screen.getByRole('button', { name: 'Filters' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveTextContent('');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'Buy' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Sell' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Thesis' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Transfer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Buy' }));
    expect(screen.getByRole('button', { name: 'Buy' })).toHaveAttribute('aria-pressed', 'false');
    expect(trigger).toHaveTextContent('1');
  });

  it('applies valid K ranges, retains the last valid range on an error, and resets', () => {
    render(<StatefulPopover />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));

    const minimum = screen.getByRole('textbox', { name: 'Minimum market cap in K' });
    const maximum = screen.getByRole('textbox', { name: 'Maximum market cap in K' });
    fireEvent.change(minimum, { target: { value: '200' } });
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveTextContent('1');

    fireEvent.change(maximum, { target: { value: '100' } });
    expect(screen.getByRole('alert')).toHaveTextContent('Minimum market cap cannot exceed maximum.');
    expect(minimum).toHaveValue('200');
    expect(maximum).toHaveValue('100');

    fireEvent.change(maximum, { target: { value: '500' } });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(minimum).toHaveValue('');
    expect(maximum).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Filters' })).toHaveTextContent('');
  });

  it('counts chain visibility as one group and reset restores all chains', () => {
    render(<StatefulPopover />);
    const trigger = screen.getByRole('button', { name: 'Filters' });
    fireEvent.click(trigger);

    fireEvent.click(screen.getByRole('button', { name: 'Base' }));
    expect(screen.getByRole('button', { name: 'Base' })).toHaveAttribute('aria-pressed', 'false');
    expect(trigger).toHaveTextContent('1');

    fireEvent.click(screen.getByRole('button', { name: 'Select all' }));
    expect(trigger).toHaveTextContent('');
    fireEvent.click(screen.getByRole('button', { name: 'Deselect all' }));
    const chains = screen.getByRole('group', { name: 'Chains' });
    expect(within(chains).getAllByRole('button', { pressed: false })).toHaveLength(6);
    expect(trigger).toHaveTextContent('1');

    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(within(chains).getAllByRole('button', { pressed: true })).toHaveLength(6);
    expect(trigger).toHaveTextContent('');
  });

  it('closes on outside click and Escape restores focus to the trigger', () => {
    render(<><StatefulPopover /><button type="button">Outside</button></>);
    const trigger = screen.getByRole('button', { name: 'Filters' });
    fireEvent.click(trigger);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it.each([
    ['Buy', 'feed-filter-action-buy'],
    ['Sell', 'feed-filter-action-sell'],
    ['Thesis', 'feed-filter-action-thesis'],
  ] as const)('adds the semantic %s action class', (name, className) => {
    render(<StatefulPopover />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));

    expect(screen.getByRole('button', { name })).toHaveClass(className);
  });
});
