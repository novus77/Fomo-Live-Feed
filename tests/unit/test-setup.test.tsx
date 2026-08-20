import { render, screen } from '@testing-library/react';

const HarnessGuard = () => <span>harness ready</span>;

describe('test harness', () => {
  it('renders a component and exposes jest-dom matchers', () => {
    render(<HarnessGuard />);

    expect(screen.getByText('harness ready')).toBeInTheDocument();
  });
});
