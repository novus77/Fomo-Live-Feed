import { render, screen } from '@testing-library/react';

import {
  isUnsupportedSidePanelUrl,
  UnsupportedSidePanel,
} from '../../src/sidepanel/UnsupportedSidePanel';

describe('UnsupportedSidePanel', () => {
  it('recognizes only the explicit action fallback URL', () => {
    expect(isUnsupportedSidePanelUrl('chrome-extension://id/sidepanel.html?unsupported=side-panel')).toBe(true);
    expect(isUnsupportedSidePanelUrl('chrome-extension://id/sidepanel.html')).toBe(false);
    expect(isUnsupportedSidePanelUrl('not a url')).toBe(false);
  });

  it('shows the required browser version and unavailable reason', () => {
    render(<UnsupportedSidePanel />);
    expect(screen.getByRole('heading', { name: 'Side Panel unavailable' })).toBeInTheDocument();
    expect(screen.getByText(/Chrome 114 or newer/)).toBeInTheDocument();
  });
});
