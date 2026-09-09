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
      onOpenChange={(nextOpen) => setOpen(nextOpen)}
      onFiltersChange={setFilters}
    />
  );
}

describe('FeedFilterPopover', () => {
  it('selects exactly one source mode at a time', () => {
    render(<StatefulPopover />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));

    const sources = screen.getByRole('group', { name: 'Sources' });
    expect(within(sources).getByRole('button', { name: 'All sources' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(within(sources).getByRole('button', { name: /Pump/ }));
    expect(within(sources).getByRole('button', { name: /Pump/ })).toHaveAttribute('aria-pressed', 'true');
    expect(within(sources).getByRole('button', { name: 'All sources' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /Filters.*Source Pump/ })).toHaveTextContent('1');
  });

  it('uses an icon-only accessible funnel trigger and independent action toggles', () => {
    render(<StatefulPopover />);

    const trigger = screen.getByRole('button', { name: 'Filters' });
    expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveTextContent('');

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(trigger).toHaveAttribute('aria-controls');
    expect(screen.getByRole('dialog')).toHaveAttribute('id', trigger.getAttribute('aria-controls'));
    expect(screen.getByRole('button', { name: 'Buy' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All sources' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Sell' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Thesis' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('button', { name: 'Transfer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Buy' }));
    expect(screen.getByRole('button', { name: 'Buy' })).toHaveAttribute('aria-pressed', 'false');
    expect(trigger).toHaveTextContent('1');
    expect(trigger).toHaveAttribute('aria-label', expect.stringMatching(/Hidden Buy/));
    expect(trigger.querySelector('.sidepanel-filter-count')).toHaveAttribute('aria-hidden', 'true');
  });

  it('applies valid K ranges, retains the last valid range on an error, and resets', () => {
    render(<StatefulPopover />);
    const trigger = screen.getByRole('button', { name: 'Filters' });
    fireEvent.click(trigger);

    const minimum = screen.getByRole('textbox', { name: 'Minimum market cap in K' });
    const maximum = screen.getByRole('textbox', { name: 'Maximum market cap in K' });
    fireEvent.change(minimum, { target: { value: '200' } });
    expect(trigger).toHaveTextContent('');
    fireEvent.blur(minimum);
    expect(trigger).toHaveTextContent('1');
    expect(trigger).toHaveAttribute('aria-label', expect.stringMatching(/MC ≥ 200K/));

    fireEvent.change(maximum, { target: { value: '100' } });
    fireEvent.blur(maximum);
    expect(screen.getByRole('alert')).toHaveTextContent('Minimum market cap cannot exceed maximum.');
    expect(minimum).toHaveValue('200');
    expect(maximum).toHaveValue('100');

    fireEvent.change(maximum, { target: { value: '500' } });
    fireEvent.keyDown(maximum, { key: 'Enter' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(minimum).toHaveValue('');
    expect(maximum).toHaveValue('');
    expect(trigger).toHaveTextContent('');
    expect(trigger).toHaveAttribute('aria-label', 'Filters');
  });

  it('applies raw USD buy ranges, retains the last valid range on an error, and resets', () => {
    render(<StatefulPopover />);
    const trigger = screen.getByRole('button', { name: 'Filters' });
    fireEvent.click(trigger);

    const minimum = screen.getByRole('textbox', { name: 'Minimum buy amount in USD' });
    const maximum = screen.getByRole('textbox', { name: 'Maximum buy amount in USD' });
    fireEvent.change(minimum, { target: { value: '5' } });
    fireEvent.blur(minimum);
    expect(trigger).toHaveTextContent('1');
    expect(trigger).toHaveAttribute('aria-label', expect.stringMatching(/Buy ≥ \$5/));

    fireEvent.change(maximum, { target: { value: '4.99' } });
    fireEvent.blur(maximum);
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Minimum buy amount cannot exceed maximum.',
    );

    fireEvent.change(maximum, { target: { value: '100' } });
    fireEvent.keyDown(maximum, { key: 'Enter' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-label', expect.stringMatching(/Buy \$5–\$100/));

    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(minimum).toHaveValue('');
    expect(maximum).toHaveValue('');
    expect(trigger).toHaveTextContent('');
  });

  it('counts chain visibility as one group and reset restores all chains', () => {
    render(<StatefulPopover />);
    const trigger = screen.getByRole('button', { name: 'Filters' });
    fireEvent.click(trigger);

    fireEvent.click(screen.getByRole('button', { name: 'Base' }));
    expect(screen.getByRole('button', { name: 'Base' })).toHaveAttribute('aria-pressed', 'false');
    expect(trigger).toHaveTextContent('1');
    expect(trigger).toHaveAttribute('title', expect.stringContaining('5/6'));
    expect(trigger).toHaveAttribute('aria-label', expect.stringMatching(/Chains 5\/6/));

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

  it('does not move focus back to Buy after another filter is toggled', () => {
    render(<StatefulPopover />);
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const sell = screen.getByRole('button', { name: 'Sell' });

    sell.focus();
    fireEvent.click(sell);

    expect(sell).toHaveFocus();
  });

  it('closes on outside click and Escape restores focus to the trigger', () => {
    render(<><StatefulPopover /><button type="button">Outside</button></>);
    const trigger = screen.getByRole('button', { name: 'Filters' });
    fireEvent.click(trigger);
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Outside' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    fireEvent.change(screen.getByRole('textbox', { name: 'Minimum market cap in K' }), {
      target: { value: '250' },
    });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(trigger);
    expect(screen.getByRole('textbox', { name: 'Minimum market cap in K' })).toHaveValue('');
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
