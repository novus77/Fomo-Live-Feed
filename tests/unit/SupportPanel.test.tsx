import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import {
  BSC_SUPPORT_ADDRESS,
  SOLANA_SUPPORT_ADDRESS,
  SupportPanel,
} from '../../src/sidepanel/SupportPanel';

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

describe('SupportPanel', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses compact utility sections without changing support destinations', () => {
    const { container } = render(
      <SupportPanel copyText={vi.fn().mockResolvedValue(undefined)} openLink={vi.fn()} />,
    );

    expect(container.querySelector('.support-panel')).toHaveClass('utility-panel');
    expect(container.querySelectorAll('.utility-section')).toHaveLength(2);
    expect(screen.getByText('Robinhood & BSC')).toBeVisible();
    expect(screen.getByText(BSC_SUPPORT_ADDRESS)).toBeVisible();
    expect(screen.getByText(SOLANA_SUPPORT_ADDRESS)).toBeVisible();
  });

  it('renders complete addresses and the bounded co-creation benefits', () => {
    render(<SupportPanel copyText={vi.fn()} openLink={vi.fn()} />);

    expect(screen.getByText(BSC_SUPPORT_ADDRESS)).not.toHaveTextContent('…');
    expect(screen.getByText(SOLANA_SUPPORT_ADDRESS)).not.toHaveTextContent('…');
    expect(
      screen.getByRole('heading', { name: 'Developer Co-creation Group' }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Join extension optimization discussions'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Discuss shared customization needs'),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Get early access to new extensions'),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /copy .* address/i }))
      .toEqual(
        expect.arrayContaining([
          expect.objectContaining({ textContent: 'Copy' }),
        ]),
      );
  });

  it('opens the fixed Telegram URL through the injected boundary', () => {
    const openLink = vi.fn();
    render(<SupportPanel copyText={vi.fn()} openLink={openLink} />);

    fireEvent.click(screen.getByRole('link', { name: '@XXten177' }));

    expect(openLink).toHaveBeenCalledTimes(1);
    expect(openLink.mock.calls[0]?.[0]).toEqual(new URL('https://t.me/XXten177'));
  });

  it('copies each address and keeps feedback scoped to that row', async () => {
    const copyText = vi.fn().mockResolvedValue(undefined);
    render(<SupportPanel copyText={copyText} openLink={vi.fn()} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Copy Robinhood & BSC address' }),
    );
    await waitFor(() =>
      expect(copyText).toHaveBeenCalledWith(BSC_SUPPORT_ADDRESS),
    );
    expect(screen.getAllByRole('status')).toHaveLength(1);

    fireEvent.click(
      screen.getByRole('button', { name: 'Copy Solana address' }),
    );
    await waitFor(() =>
      expect(copyText).toHaveBeenLastCalledWith(SOLANA_SUPPORT_ADDRESS),
    );
    expect(screen.getAllByRole('status')).toHaveLength(2);
  });

  it('keeps the address selectable and reports clipboard failure', async () => {
    const copyText = vi.fn().mockRejectedValue(new Error('denied'));
    render(<SupportPanel copyText={copyText} openLink={vi.fn()} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Copy Robinhood & BSC address' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent('Copy failed');
    expect(screen.getByText(BSC_SUPPORT_ADDRESS)).toBeInTheDocument();
  });

  it('clears copy feedback after two seconds', async () => {
    vi.useFakeTimers();
    const copyText = vi.fn().mockResolvedValue(undefined);
    render(<SupportPanel copyText={copyText} openLink={vi.fn()} />);

    fireEvent.click(
      screen.getByRole('button', { name: 'Copy Robinhood & BSC address' }),
    );
    await act(async () => {});
    expect(screen.getByRole('status')).toHaveTextContent('Copied');

    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
