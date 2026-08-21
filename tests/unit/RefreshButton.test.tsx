import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { ActivitySyncState } from '../../src/background/activity-sync';
import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import { RefreshButton } from '../../src/sidepanel/RefreshButton';

// Refresh labels render through useLocale (EN catalog here); the real
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

const NOW = 1_800_000_000_000;

describe('RefreshButton', () => {
  it.each([
    [{ status: 'idle' }, 'Ready'],
    [{ status: 'syncing', reason: 'manual', startedAt: NOW }, 'Refreshing…'],
    [{ status: 'updated', added: 3, finishedAt: NOW }, 'Updated'],
    [{ status: 'current', finishedAt: NOW }, 'Up to date'],
    [{ status: 'offline' }, 'Offline'],
    [{ status: 'login-required' }, 'Login required'],
    [{ status: 'recovery-unavailable' }, 'Recovery unavailable'],
    [{ status: 'failed', retryable: true, finishedAt: NOW }, 'Refresh failed'],
  ] as const)('renders the %s recovery state as a live status', (state, label) => {
    render(<RefreshButton state={state} onRefresh={() => {}} />);

    expect(screen.getByRole('status')).toHaveTextContent(label);
  });

  it('renders an icon-only accessible refresh button', () => {
    render(<RefreshButton state={{ status: 'idle' }} onRefresh={() => {}} />);

    const button = screen.getByRole('button', { name: 'Refresh' });

    expect(button).toHaveAttribute('title', 'Refresh');
    expect(button).toHaveAttribute('aria-label', 'Refresh');
    expect(button.querySelector('svg')).not.toBeNull();
    expect(button).not.toHaveTextContent('Refresh');
  });

  it('fires onRefresh when clicked', () => {
    const onRefresh = vi.fn();

    render(
      <RefreshButton state={{ status: 'current', finishedAt: NOW }} onRefresh={onRefresh} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ status: 'syncing', reason: 'manual', startedAt: NOW }],
    [{ status: 'offline' }],
    [{ status: 'login-required' }],
  ] as const)('disables the button while the state is %s', (state) => {
    render(<RefreshButton state={state} onRefresh={() => {}} />);

    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
  });

  it('keeps the button enabled for idle, updated, current, failed, and recovery-unavailable', () => {
    const states: ActivitySyncState[] = [
      { status: 'idle' },
      { status: 'updated', added: 2, finishedAt: NOW },
      { status: 'current', finishedAt: NOW },
      { status: 'failed', retryable: false, finishedAt: NOW },
      { status: 'recovery-unavailable' },
    ];

    for (const state of states) {
      const { unmount } = render(
        <RefreshButton state={state} onRefresh={() => {}} />,
      );

      expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
      unmount();
    }
  });

  it('respects the disabled prop even when the state allows a refresh', () => {
    render(
      <RefreshButton state={{ status: 'idle' }} onRefresh={() => {}} disabled />,
    );

    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
  });

  it('spins the icon while a sync is in flight', () => {
    render(
      <RefreshButton
        state={{ status: 'syncing', reason: 'manual', startedAt: NOW }}
        onRefresh={() => {}}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'Refresh' }).querySelector('.refresh-icon-spin'),
    ).not.toBeNull();
  });
});
