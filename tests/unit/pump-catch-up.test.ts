import { PumpCatchUpCollector } from '../../src/pump/catch-up';

const trade = (key: string, occurredAt: number) => ({ key, occurredAt });

describe('PumpCatchUpCollector', () => {
  it('collects newer trades until the old watermark and drains oldest first', () => {
    const collector = new PumpCatchUpCollector({
      watermark: 'old',
      startedAt: 100_000,
    });

    const result = collector.acceptPage(
      [trade('new-3', 99_000), trade('new-2', 98_000), trade('old', 97_000)],
      'next',
    );

    expect(result).toEqual({ status: 'complete' });
    expect(collector.drainAscending()).toEqual([
      trade('new-2', 98_000),
      trade('new-3', 99_000),
    ]);
  });

  it('yields after five pages while preserving the next cursor', () => {
    const collector = new PumpCatchUpCollector({ watermark: 'old', startedAt: 100_000 });

    for (let page = 1; page < 5; page += 1) {
      expect(collector.acceptPage([trade(`new-${page}`, 99_000 - page)], `c-${page}`))
        .toEqual({ status: 'continue', cursor: `c-${page}` });
    }

    expect(collector.acceptPage([trade('new-5', 98_000)], 'c-5')).toEqual({
      status: 'yield',
      cursor: 'c-5',
    });
  });

  it.each([
    ['missing cursor', undefined],
    ['repeated cursor', 'same'],
  ])('reports a possible gap for %s', (_label, nextCursor) => {
    const collector = new PumpCatchUpCollector({ watermark: 'old', startedAt: 100_000 });

    if (nextCursor === 'same') {
      collector.acceptPage([trade('new-1', 99_000)], 'same');
    }

    expect(collector.acceptPage([trade('new-2', 98_000)], nextCursor)).toEqual({
      status: 'possible-gap',
      reason: nextCursor === undefined ? 'endpoint-ended' : 'cursor-loop',
    });
  });

  it('reports a possible gap at the event and age boundaries', () => {
    const countBounded = new PumpCatchUpCollector({
      watermark: 'old',
      startedAt: 100_000,
      maximumEvents: 2,
    });
    expect(countBounded.acceptPage(
      [trade('a', 99_000), trade('b', 98_000), trade('c', 97_000)],
      'next',
    )).toEqual({ status: 'possible-gap', reason: 'event-limit' });

    const ageBounded = new PumpCatchUpCollector({
      watermark: 'old',
      startedAt: 100_000,
      maximumAgeMs: 10_000,
    });
    expect(ageBounded.acceptPage([trade('a', 89_999)], 'next')).toEqual({
      status: 'possible-gap',
      reason: 'age-limit',
    });
  });

  it('deduplicates buffered keys across pages', () => {
    const collector = new PumpCatchUpCollector({ watermark: 'old', startedAt: 100_000 });
    collector.acceptPage([trade('same', 99_000)], 'c-1');
    collector.acceptPage([trade('same', 99_000), trade('old', 98_000)], 'c-2');

    expect(collector.drainAscending()).toEqual([trade('same', 99_000)]);
  });
});
