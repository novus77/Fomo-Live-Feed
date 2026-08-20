import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { CopyableAddress } from '../../src/sidepanel/CopyableAddress';

const ADDRESS = '0x020BFC650A365F8BB26819DEAABF3E21291018B4';
const CANONICAL = ADDRESS.toLowerCase();

describe('CopyableAddress', () => {
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

  it('keeps invalid and unknown-chain addresses visible and copyable as untrusted text', async () => {
    const copyText = vi.fn().mockResolvedValue(undefined);
    render(
      <CopyableAddress chain="unknown" address="not-an-address" copyText={copyText} />,
    );

    fireEvent.click(screen.getByText('CA: not-an-address'));
    await waitFor(() => expect(copyText).toHaveBeenCalledWith('not-an-address'));
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
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
});
