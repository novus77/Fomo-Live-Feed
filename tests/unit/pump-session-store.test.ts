import {
  parsePumpSessionState,
  parsePumpStatusSnapshot,
} from '../../src/background/pump-session-store';

describe('Pump session storage boundary', () => {
  it('accepts a bounded watermark snapshot', () => {
    expect(parsePumpSessionState({
      watermark: '1399811149:transaction',
      recentKeys: ['1399811149:transaction'],
    })).toEqual({
      watermark: '1399811149:transaction',
      recentKeys: ['1399811149:transaction'],
    });
  });

  it.each([
    null,
    { watermark: '', recentKeys: [] },
    { recentKeys: ['x'.repeat(513)] },
    { recentKeys: Array.from({ length: 2_049 }, () => 'key') },
    { recentKeys: [], unexpected: true },
  ])('rejects damaged or unbounded state %#', (value) => {
    expect(parsePumpSessionState(value)).toBeUndefined();
  });
});

describe('Pump status storage boundary', () => {
  it('accepts only a strict status snapshot', () => {
    expect(parsePumpStatusSnapshot({
      epoch: 2,
      status: 'rate-limited',
      at: 100,
      backoffLevel: 1,
    })).toEqual({ epoch: 2, status: 'rate-limited', at: 100, backoffLevel: 1 });
    expect(parsePumpStatusSnapshot({
      epoch: 2,
      status: 'unknown-status',
      at: 100,
      backoffLevel: 1,
    })).toBeUndefined();
  });

  it('accepts a runtime status payload and projects away worker-only identity', () => {
    expect(parsePumpStatusSnapshot({
      epoch: 2,
      workerSessionId: 'worker-session',
      status: 'live',
      at: 100,
      backoffLevel: 1,
    })).toEqual({ epoch: 2, status: 'live', at: 100, backoffLevel: 1 });
  });
});
