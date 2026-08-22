import { describe, expect, it } from 'vitest';

import { needsFomoRefresh } from '../../src/sidepanel/pipeline-health-view';

describe('needsFomoRefresh', () => {
  it('requests a refresh only for an installed observer that missed the existing socket', () => {
    expect(needsFomoRefresh({
      hasFomoTab: true,
      observerInstalled: true,
      socketObserved: false,
      connected: false,
    })).toBe(true);
  });

  it.each([
    { hasFomoTab: false, observerInstalled: true, socketObserved: false, connected: false },
    { hasFomoTab: true, observerInstalled: false, socketObserved: false, connected: false },
    { hasFomoTab: true, observerInstalled: true, socketObserved: true, connected: false },
    { hasFomoTab: true, observerInstalled: true, socketObserved: false, connected: true },
  ])('does not request a refresh for %j', (input) => {
    expect(needsFomoRefresh(input)).toBe(false);
  });
});
