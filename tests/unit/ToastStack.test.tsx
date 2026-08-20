import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { TraderAnnotationV1 } from '../../src/domain/annotations';
import type { TradeEventV1 } from '../../src/domain/activity';
import { DEFAULT_SETTINGS } from '../../src/domain/settings';
import { createToastQueue } from '../../src/overlay/toast-queue';
import { ToastStack } from '../../src/overlay/ToastStack';
const toastStyles = readFileSync(
  resolve('entrypoints/trading-overlay.content/style.css'),
  'utf8',
);

const NOW = 1_800_000_000_000;
const TOKEN_ADDRESS = '0x020bfc650a365f8bb26819deaabf3e21291018b4';

function makeEvent(overrides: Partial<TradeEventV1> = {}): TradeEventV1 {
  return {
    schemaVersion: 1,
    id: 'fomo:activity-1',
    source: 'fomo',
    traderId: 'trader-1',
    traderHandle: 'alpha',
    traderName: 'Alpha Whale',
    traderAvatarUrl: 'https://example.com/avatar.png',
    chain: 'bsc',
    tokenAddress: TOKEN_ADDRESS,
    tokenSymbol: 'FOMO',
    tokenImageUrl: 'https://example.com/token.png',
    action: 'buy',
    usdAmount: 1250.5,
    occurredAt: NOW - 120_000,
    receivedAt: NOW,
    metricSnapshot: {
      fetchedAt: NOW,
      source: 'fomo-profile',
      pnl7d: 1250,
      winRate7d: 62.5,
    },
    ...overrides,
  };
}

type ToastStackProps = ComponentProps<typeof ToastStack>;

const defaultProps: ToastStackProps = {
  events: [makeEvent()],
  settings: DEFAULT_SETTINGS,
  now: () => NOW,
  copyText: vi.fn().mockResolvedValue(undefined),
};

function renderStack(overrides: Partial<ToastStackProps> = {}) {
  return render(<ToastStack {...defaultProps} {...overrides} />);
}

describe('ToastStack card content', () => {
  it('does not override the centralized chain color in toast-specific CSS', () => {
    const rule = toastStyles.match(/\.toast-chain-badge\s*\{([^}]*)\}/)?.[1];

    expect(rule).toBeDefined();
    expect(rule).not.toMatch(/(?:^|;)\s*color\s*:/);
  });

  it('renders trader identity, action, token, chain, amount, and relative time', () => {
    renderStack();

    expect(screen.getByText('Alpha Whale')).toBeInTheDocument();
    expect(screen.getByText('@alpha')).toBeInTheDocument();
    expect(screen.getByText('Buy')).toBeInTheDocument();
    expect(screen.getByText('$FOMO')).toBeInTheDocument();
    expect(screen.getByText('BSC')).toBeInTheDocument();
    expect(screen.getByText('BSC').closest('.chain-badge')?.querySelector('svg')).not.toBeNull();
    expect(screen.getByText('$1.25K')).toBeInTheDocument();
    expect(screen.getByText('2m ago')).toBeInTheDocument();
  });

  it('renders a thesis action and its comment', () => {
    const event = makeEvent({ action: 'thesis', thesis: 'Rotation into L1s' });
    renderStack({ events: [event] });

    expect(screen.getByText('Thesis')).toBeInTheDocument();
    expect(screen.getByText('Rotation into L1s')).toBeInTheDocument();
  });

  it('renders the configured metrics with honest 7d labels', () => {
    renderStack();

    expect(screen.getByText('7d PnL')).toBeInTheDocument();
    expect(screen.getByText('+$1.25K')).toBeInTheDocument();
    expect(screen.getByText('7d Win Rate')).toBeInTheDocument();
    expect(screen.getByText('62.5%')).toBeInTheDocument();
  });

  it('renders Unavailable for a configured metric without a snapshot value, never 0', () => {
    const event = makeEvent({
      metricSnapshot: { fetchedAt: NOW, source: 'fomo-profile', winRate7d: 62.5 },
    });
    const settings = { ...DEFAULT_SETTINGS, metrics: { primary: 'pnl7d' as const } };

    renderStack({ events: [event], settings });

    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('renders no metric rows when both metric slots are disabled', () => {
    const settings = { ...DEFAULT_SETTINGS, metrics: {} };

    renderStack({ settings });

    expect(screen.queryByText('7d PnL')).not.toBeInTheDocument();
    expect(screen.queryByText('7d Win Rate')).not.toBeInTheDocument();
  });

  it('honors a replaced metric slot', () => {
    const event = makeEvent({
      metricSnapshot: { fetchedAt: NOW, source: 'fomo-profile', followers: 1234 },
    });
    const settings = {
      ...DEFAULT_SETTINGS,
      metrics: { primary: 'followers' as const, secondary: 'winRate7d' as const },
    };

    renderStack({ events: [event], settings });

    expect(screen.getByText('Followers')).toBeInTheDocument();
    expect(screen.getByText('1.23K')).toBeInTheDocument();
    expect(screen.getByText('7d Win Rate')).toBeInTheDocument();
  });

  it('renders the custom trader label from an annotation', () => {
    const annotations = new Map<string, TraderAnnotationV1>([
      ['trader-1', { traderId: 'trader-1', label: 'Whale Watch', color: '#8b5cf6', updatedAt: NOW }],
    ]);

    renderStack({ annotations });

    expect(screen.getByText('Whale Watch')).toBeInTheDocument();
  });

  it('renders an empty stack without cards', () => {
    const { container } = renderStack({ events: [] });

    expect(container.querySelectorAll('.toast-card')).toHaveLength(0);
  });
});

describe('ToastStack contract address', () => {
  it('shows the shortened address and copies the complete validated address', () => {
    const copyText = vi.fn().mockResolvedValue(undefined);

    renderStack({ copyText });

    const copyButton = screen.getByRole('button', { name: /copy full address/i });

    expect(copyButton).toHaveTextContent('0x020b…18b4');

    fireEvent.click(copyButton);

    expect(copyText).toHaveBeenCalledWith(TOKEN_ADDRESS);
  });

  it('renders no copy action for an invalid contract address', () => {
    const copyText = vi.fn();
    const event = makeEvent({ tokenAddress: 'not-an-address' });

    renderStack({ events: [event], copyText });

    expect(screen.queryByRole('button', { name: /copy full address/i })).not.toBeInTheDocument();
    expect(copyText).not.toHaveBeenCalled();
  });
});

describe('ToastStack navigation', () => {
  it('opens the verified token page when the card body is clicked', () => {
    const openLink = vi.fn();
    const { container } = renderStack({ openLink });

    const card = container.querySelector('.toast-card') as HTMLElement | null;

    if (card === null) {
      throw new Error('missing toast card');
    }

    fireEvent.click(card);

    expect(openLink).toHaveBeenCalledTimes(1);

    const target = openLink.mock.calls[0]?.[0] as URL | undefined;

    expect(target).toBeInstanceOf(URL);
    expect(target?.href).toBe(`https://fomo.family/token/bsc/${TOKEN_ADDRESS}`);
  });

  it('does not open a link when the token address is invalid', () => {
    const openLink = vi.fn();
    const event = makeEvent({ tokenAddress: 'not-an-address' });
    const { container } = renderStack({ events: [event], openLink });

    const card = container.querySelector('.toast-card') as HTMLElement | null;

    if (card === null) {
      throw new Error('missing toast card');
    }

    fireEvent.click(card);

    expect(openLink).not.toHaveBeenCalled();
  });

  it('links the trader identity to the verified profile page', () => {
    renderStack();

    const profileLink = screen.getByRole('link', { name: /alpha whale/i });

    expect(profileLink).toHaveAttribute('href', 'https://fomo.family/user/alpha');
    expect(profileLink).toHaveAttribute('target', '_blank');
    expect(profileLink.getAttribute('rel')).toMatch(/noopener/);
  });

  it('renders the trader identity without a link when the handle is invalid', () => {
    const event = makeEvent({ traderHandle: 'bad handle' });
    const { container } = renderStack({ events: [event] });

    const card = container.querySelector('.toast-card') as HTMLElement | null;

    if (card === null) {
      throw new Error('missing toast card');
    }

    expect(within(card).queryByRole('link')).not.toBeInTheDocument();
    expect(within(card).getByText('Alpha Whale')).toBeInTheDocument();
  });
});

describe('ToastStack image fallbacks', () => {
  it('renders deterministic initials when no avatar url exists', () => {
    const event = makeEvent();

    delete event.traderAvatarUrl;

    renderStack({ events: [event] });

    expect(screen.getByText('AW')).toBeInTheDocument();
  });

  it('swaps a failed avatar image to deterministic initials', () => {
    const { container } = renderStack();

    const images = container.querySelectorAll('img');
    const avatar = images[0] as HTMLImageElement | undefined;

    if (avatar === undefined) {
      throw new Error('missing avatar image');
    }

    fireEvent.error(avatar);

    expect(screen.getByText('AW')).toBeInTheDocument();
  });

  it('swaps a failed token image to the symbol fallback', () => {
    const { container } = renderStack();

    const images = container.querySelectorAll('img');
    const token = images[1] as HTMLImageElement | undefined;

    if (token === undefined) {
      throw new Error('missing token image');
    }

    fireEvent.error(token);

    expect(screen.getByText('FOMO')).toBeInTheDocument();
  });
});

describe('ToastStack interactions', () => {
  it('calls onClose with the card id when dismissed', () => {
    const onClose = vi.fn();

    renderStack({ onClose });

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));

    expect(onClose).toHaveBeenCalledWith('fomo:activity-1');
  });

  it('keeps a hovered card visible after its 8s window would have elapsed', () => {
    vi.useFakeTimers();

    try {
      const onHoverChange = vi.fn();
      const queue = createToastQueue({
        durationMs: 8_000,
        now: () => Date.now(),
      });

      queue.push(makeEvent({ id: 'e1' }));
      queue.push(makeEvent({ id: 'e2' }));
      queue.setHovered('e1');

      const { container, rerender } = renderStack({
        events: queue.visible(),
        onHoverChange,
      });

      const cards = container.querySelectorAll('.toast-card');

      expect(cards).toHaveLength(2);

      const first = cards[0];

      if (first === undefined) {
        throw new Error('missing card');
      }

      fireEvent.mouseEnter(first);

      expect(onHoverChange).toHaveBeenLastCalledWith('e1');

      // Hovering pauses dismissal: even after the 8s window, the queue still
      // returns the hovered card and the user still sees it rendered.
      vi.advanceTimersByTime(8_000);

      const stillVisible = queue.visible();

      expect(stillVisible.map((event) => event.id)).toContain('e1');

      rerender(
        <ToastStack
          events={stillVisible}
          settings={defaultProps.settings}
          now={defaultProps.now}
          copyText={defaultProps.copyText}
          onHoverChange={onHoverChange}
        />,
      );

      expect(container.querySelector('.toast-card')).not.toBeNull();

      fireEvent.mouseLeave(first);

      expect(onHoverChange).toHaveBeenLastCalledWith(null);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders untrusted values as text, never as markup', () => {
    const event = makeEvent({
      traderName: '<img src="x" onerror="alert(1)">',
      tokenSymbol: '<b>FOMO</b>',
    });

    const { container } = renderStack({ events: [event] });

    expect(screen.getByText('<img src="x" onerror="alert(1)">')).toBeInTheDocument();
    expect(screen.getByText('$<b>FOMO</b>')).toBeInTheDocument();
    expect(container.querySelector('img[src="x"]')).toBeNull();
  });
});
