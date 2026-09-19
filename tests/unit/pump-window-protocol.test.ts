import {
  PUMP_WINDOW_NAMESPACE,
  parsePumpLeaseCommand,
  parsePumpRuntimeCandidate,
} from '../../src/pump/window-protocol';

describe('Pump window protocol', () => {
  it('accepts a bounded lease command and Pump runtime candidate', () => {
    expect(parsePumpLeaseCommand({
      namespace: PUMP_WINDOW_NAMESPACE,
      protocolVersion: 1,
      type: 'pump.leaseCommand',
      payload: {
        granted: true,
        workerSessionId: 'worker-a',
        epoch: 2,
        expiresAt: 9_000,
        seed: { watermark: 'chain:tx', recentKeys: ['chain:tx'] },
      },
    })).toEqual(expect.objectContaining({ payload: expect.objectContaining({ epoch: 2 }) }));

    expect(parsePumpRuntimeCandidate({
      namespace: PUMP_WINDOW_NAMESPACE,
      protocolVersion: 1,
      type: 'pump.runtimeCandidate',
      message: {
        protocolVersion: 1,
        type: 'pump.status',
        payload: { epoch: 2, status: 'live', at: 1_000, backoffLevel: 0 },
      },
    })).toEqual(expect.objectContaining({ message: expect.objectContaining({ type: 'pump.status' }) }));
  });

  it('rejects extra fields, oversized seed state, and non-Pump messages', () => {
    expect(parsePumpLeaseCommand({
      namespace: PUMP_WINDOW_NAMESPACE,
      protocolVersion: 1,
      type: 'pump.leaseCommand',
      payload: { granted: false, workerSessionId: 'worker-a', epoch: 1, expiresAt: 1, extra: true },
    })).toBeNull();

    expect(parsePumpRuntimeCandidate({
      namespace: PUMP_WINDOW_NAMESPACE,
      protocolVersion: 1,
      type: 'pump.runtimeCandidate',
      message: { protocolVersion: 1, type: 'events.query', payload: { limit: 10 } },
    })).toBeNull();
  });
});
