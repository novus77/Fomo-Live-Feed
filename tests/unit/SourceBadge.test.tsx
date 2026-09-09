import { render, screen } from '@testing-library/react';
import type { TradeEventV1 } from '../../src/domain/activity';
import { SourceBadge, projectedEventSources } from '../../src/sidepanel/SourceBadge';

const event: TradeEventV1 = {
  schemaVersion: 1,
  id: 'merged',
  source: 'fomo',
  sources: ['fomo', 'pump'],
  traderId: 'trader',
  traderHandle: 'trader',
  chain: 'solana',
  tokenAddress: 'mint',
  tokenSymbol: 'TOKEN',
  action: 'buy',
  occurredAt: 1,
  receivedAt: 2,
};

describe('SourceBadge', () => {
  it('projects merged provenance according to the selected source filter', () => {
    expect(projectedEventSources(event, 'all')).toEqual(['fomo', 'pump']);
    expect(projectedEventSources(event, 'fomo')).toEqual(['fomo']);
    expect(projectedEventSources(event, 'pump')).toEqual(['pump']);
  });

  it('renders both accessible source icons without adding a card row', () => {
    const { container } = render(<SourceBadge event={event} />);
    expect(screen.getByLabelText('Fomo + Pump')).toBeInTheDocument();
    expect(container.querySelectorAll('img')).toHaveLength(2);
  });

  it('supports a decorative avatar projection without duplicating accessibility output', () => {
    const { container } = render(<SourceBadge event={event} placement="avatar" decorative />);
    const badge = container.querySelector('.event-source-badge-avatar');

    expect(badge).toHaveAttribute('aria-hidden', 'true');
    expect(badge?.querySelectorAll('img')).toHaveLength(2);
  });
});
