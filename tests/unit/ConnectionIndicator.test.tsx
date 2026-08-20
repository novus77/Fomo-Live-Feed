import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ConnectionIndicator } from '../../src/sidepanel/ConnectionIndicator';

describe('ConnectionIndicator', () => {
  it.each([
    ['loading', 'Checking…'],
    ['connected', 'Connected'],
    ['reconnecting', 'Reconnecting'],
    ['offline', 'Offline'],
    ['login-required', 'Login required'],
  ] as const)('renders %s as a permanent status', (state, label) => {
    render(<ConnectionIndicator state={state} />);

    expect(screen.getByRole('status')).toHaveTextContent(label);
  });
});
