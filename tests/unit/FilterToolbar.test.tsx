import { fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_FILTERS,
  type PopupEventFilters,
} from '../../src/popup/event-query';
import { FilterToolbar } from '../../src/sidepanel/FilterToolbar';

const ACTIVE_FILTERS: PopupEventFilters = {
  unreadOnly: true,
  action: 'buy',
  chain: 'bsc',
  traderId: 'trader-1',
  tokenAddress: '0xtoken',
  search: 'alpha',
};

function StatefulToolbar() {
  const [filters, setFilters] = useState(ACTIVE_FILTERS);
  const [pinnedFirst, setPinnedFirst] = useState(true);

  return (
    <FilterToolbar
      filters={filters}
      pinnedFirst={pinnedFirst}
      traders={[{ traderId: 'trader-1', handle: 'alpha', name: 'Alpha' }]}
      tokens={[{ address: '0xtoken', symbol: 'FOMO' }]}
      onFiltersChange={setFilters}
      onPinnedFirstChange={setPinnedFirst}
    />
  );
}

describe('FilterToolbar', () => {
  it('keeps search separate and counts active filters without search or pinned ordering', () => {
    render(<StatefulToolbar />);

    expect(screen.getByRole('searchbox', { name: 'Search history' })).toHaveValue('alpha');
    expect(screen.getByRole('button', { name: 'Filters, 5 active' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Pinned' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('opens an accessible filter dialog and updates each select', () => {
    const onFiltersChange = vi.fn();

    render(
      <FilterToolbar
        filters={DEFAULT_FILTERS}
        pinnedFirst={false}
        traders={[{ traderId: 'trader-1', handle: 'alpha', name: 'Alpha' }]}
        tokens={[{ address: '0xtoken', symbol: 'FOMO' }]}
        onFiltersChange={onFiltersChange}
        onPinnedFirstChange={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const dialog = screen.getByRole('dialog', { name: 'Event filters' });

    expect(within(dialog).getByLabelText('Action')).toBeVisible();
    expect(within(dialog).getByLabelText('Action')).toHaveFocus();
    expect(within(dialog).getByLabelText('Chain')).toBeVisible();
    expect(within(dialog).getByLabelText('Trader')).toBeVisible();
    expect(within(dialog).getByLabelText('Token')).toBeVisible();

    fireEvent.change(within(dialog).getByLabelText('Action'), { target: { value: 'buy' } });
    expect(onFiltersChange).toHaveBeenLastCalledWith({ ...DEFAULT_FILTERS, action: 'buy' });
  });

  it('closes on Escape and outside click, returning focus to Filters', () => {
    const onOutsideClick = vi.fn();
    render(
      <>
        <StatefulToolbar />
        <button type="button" onClick={onOutsideClick}>Outside action</button>
      </>,
    );
    const trigger = screen.getByRole('button', { name: 'Filters, 5 active' });

    fireEvent.click(trigger);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();

    fireEvent.click(trigger);
    const outside = screen.getByRole('button', { name: 'Outside action' });
    fireEvent.mouseDown(outside);
    outside.focus();
    fireEvent.mouseUp(outside);
    fireEvent.click(outside);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onOutsideClick).toHaveBeenCalledOnce();
  });

  it('removes one chip without clearing other filters', () => {
    render(<StatefulToolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Remove Action: Buy filter' }));

    expect(screen.queryByRole('button', { name: 'Remove Action: Buy filter' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Chain: BSC filter' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Filters, 4 active' })).toBeVisible();
  });

  it('resets filters to defaults and disables pinned ordering', () => {
    render(<StatefulToolbar />);

    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));

    expect(screen.getByRole('searchbox', { name: 'Search history' })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Filters' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Unread' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Pinned' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: 'Reset filters' })).not.toBeInTheDocument();
  });
});
