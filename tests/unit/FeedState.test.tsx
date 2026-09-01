import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FeedSkeleton, FeedState } from '../../src/sidepanel/FeedState';

describe('FeedState', () => {
  it('renders one compact recovery action', () => {
    const onAction = vi.fn();
    render(
      <FeedState
        tone="empty"
        message="No matching activity"
        actionLabel="Reset"
        onAction={onAction}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(onAction).toHaveBeenCalledOnce();
  });

  it('marks failures as alerts', () => {
    render(<FeedState tone="error" message="Refresh failed" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Refresh failed');
  });

  it('renders three fixed card-shaped skeletons', () => {
    const { container } = render(
      <FeedSkeleton rows={3} loadingLabel="Loading activity" />,
    );

    expect(container.querySelectorAll('.feed-skeleton-card')).toHaveLength(3);
    expect(
      screen.getByRole('status', { name: 'Loading activity' }),
    ).toHaveAttribute('aria-live', 'polite');
  });
});
