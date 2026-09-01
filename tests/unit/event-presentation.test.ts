import { describe, expect, it } from 'vitest';

import { eventPresentationClass } from '../../src/sidepanel/event-presentation';

describe('eventPresentationClass', () => {
  it.each([
    ['buy', 'event-card-buy'],
    ['sell', 'event-card-sell'],
    ['thesis', 'event-card-thesis'],
    ['transfer', 'event-card-transfer'],
    ['withdraw', 'event-card-withdraw'],
  ] as const)('maps %s to %s', (action, expected) => {
    expect(eventPresentationClass(action)).toBe(expected);
  });
});
