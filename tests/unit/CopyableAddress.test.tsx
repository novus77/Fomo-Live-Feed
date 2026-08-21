import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { LocaleContextValue } from '../../src/i18n/LocaleProvider';
import { CopyableAddress } from '../../src/sidepanel/CopyableAddress';

// CA-copy strings render through useLocale (EN catalog here); the real
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

const ADDRESS = '0x020BFC650A365F8BB26819DEAABF3E21291018B4';
const CANONICAL = ADDRESS.toLowerCase();

describe('CopyableAddress', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows and copies the full canonical address from either control', async () => {
    const copyText = vi.fn().mockResolvedValue(undefined);
    render(<CopyableAddress chain="bsc" address={ADDRESS} copyText={copyText} />);

    const address = screen.getByText(`CA: ${CANONICAL}`);
    expect(address).toHaveClass('copyable-address-value');
    expect(address).not.toHaveTextContent('…');

    fireEvent.click(address);
    await waitFor(() => expect(copyText).toHaveBeenCalledWith(CANONICAL));
    expect(screen.getByRole('status')).toHaveTextContent('Copied');

    fireEvent.click(screen.getByRole('button', { name: /copy full address/i }));
    await waitFor(() => expect(copyText).toHaveBeenCalledTimes(2));
  });

  it.each([
    ['bsc', 'not-an-address'],
    ['unknown', ADDRESS],
    // robinhood (900001) has an UNCONFIRMED placeholder address family
    // (docs/evidence/fomo-network-catalog.md): the synthetic placeholder is
    // rejected, so it must render non-interactive and never be copyable.
    ['robinhood', 'RH-SYNTH-000000000000000000000000000000'],
  ] as const)('keeps an invalid %s address selectable but non-interactive', (chain, address) => {
    const copyText = vi.fn();
    render(<CopyableAddress chain={chain} address={address} copyText={copyText} />);

    const value = screen.getByText(`CA: ${address}`);
    fireEvent.click(value);

    expect(value).not.toHaveAttribute('role');
    expect(value).not.toHaveAttribute('tabindex');
    expect(value).toHaveClass('copyable-address-value-noninteractive');
    expect(screen.queryByRole('button', { name: /copy.*address/i })).not.toBeInTheDocument();
    expect(copyText).not.toHaveBeenCalled();
  });

  it('announces clipboard failures without bubbling card navigation', async () => {
    const copyText = vi.fn().mockRejectedValue(new Error('denied'));
    const onClick = vi.fn();
    render(
      <div onClick={onClick}>
        <CopyableAddress chain="bsc" address={ADDRESS} copyText={copyText} />
      </div>,
    );

    fireEvent.click(screen.getByRole('button', { name: /copy full address/i }));
    expect(onClick).not.toHaveBeenCalled();
    expect(await screen.findByRole('alert')).toHaveTextContent('Copy failed');
  });

  it('clears feedback after its display window', async () => {
    vi.useFakeTimers();
    const copyText = vi.fn().mockResolvedValue(undefined);
    render(<CopyableAddress chain="bsc" address={ADDRESS} copyText={copyText} />);

    fireEvent.click(screen.getByRole('button', { name: /copy full address/i }));
    await act(async () => {});
    expect(screen.getByRole('status')).toHaveTextContent('Copied');

    act(() => vi.advanceTimersByTime(2_000));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('lets the latest copy operation win when promises resolve in reverse order', async () => {
    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: () => void;
    const first = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const second = new Promise<void>((resolve) => {
      resolveSecond = resolve;
    });
    const copyText = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    render(<CopyableAddress chain="bsc" address={ADDRESS} copyText={copyText} />);

    fireEvent.click(screen.getByText(`CA: ${CANONICAL}`));
    fireEvent.click(screen.getByRole('button', { name: /copy full address/i }));
    await act(async () => resolveSecond());
    expect(screen.getByRole('status')).toHaveTextContent('Copied');

    await act(async () => rejectFirst(new Error('stale failure')));
    expect(screen.getByRole('status')).toHaveTextContent('Copied');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not publish feedback or retain timers after unmount', async () => {
    vi.useFakeTimers();
    let resolveCopy!: () => void;
    const copyText = vi.fn().mockReturnValue(new Promise<void>((resolve) => {
      resolveCopy = resolve;
    }));
    const { unmount } = render(
      <CopyableAddress chain="bsc" address={ADDRESS} copyText={copyText} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /copy full address/i }));
    unmount();
    await act(async () => resolveCopy());

    expect(vi.getTimerCount()).toBe(0);
  });
});
