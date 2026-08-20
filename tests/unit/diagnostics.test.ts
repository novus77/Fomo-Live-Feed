import { describe, expect, it } from 'vitest';

import {
  DIAGNOSTIC_CODES,
  DiagnosticRecorder,
  MAX_DIAGNOSTIC_RECORDS,
  type DiagnosticCode,
  type DiagnosticRecord,
  type RecordDiagnosticInput,
} from '../../src/background/diagnostics';

describe('DiagnosticRecorder', () => {
  it('stamps records with the injected clock instead of Date.now()', () => {
    const recorder = new DiagnosticRecorder({ now: () => 1_700_000_000_000 });

    recorder.record({ code: 'schema_rejection' });

    expect(recorder.snapshot()).toEqual([
      { code: 'schema_rejection', receivedAt: 1_700_000_000_000 },
    ]);
  });

  it('stores exactly the documented record shape', () => {
    const recorder = new DiagnosticRecorder({ now: () => 7 });

    recorder.record({
      code: 'enrichment_failure',
      schemaVersion: 1,
      messageType: 'activity.ingest',
      missingFields: ['traderId'],
    });

    const record = recorder.snapshot()[0];

    expect(record).toEqual({
      code: 'enrichment_failure',
      receivedAt: 7,
      schemaVersion: 1,
      messageType: 'activity.ingest',
      missingFields: ['traderId'],
    });
    expect(Object.keys(record ?? {}).sort()).toEqual([
      'code',
      'messageType',
      'missingFields',
      'receivedAt',
      'schemaVersion',
    ]);
  });

  it.each(DIAGNOSTIC_CODES)('records the closed code %s', (code) => {
    const recorder = new DiagnosticRecorder({ now: () => 1 });

    recorder.record({ code });

    expect(recorder.snapshot()[0]?.code).toBe(code);
  });

  it('rejects codes outside the closed union', () => {
    const recorder = new DiagnosticRecorder({ now: () => 1 });

    expect(() =>
      recorder.record({ code: 'mystery-failure' as DiagnosticCode }),
    ).toThrowError(TypeError);
  });

  it('keeps at most 100 records, dropping the oldest first', () => {
    const recorder = new DiagnosticRecorder({ now: () => 1 });

    recorder.record({ code: 'bridge_disconnected', missingFields: ['userId'] });

    for (let index = 0; index < 104; index += 1) {
      recorder.record({ code: 'bridge_disconnected', missingFields: ['chain'] });
    }

    const snapshot = recorder.snapshot();

    expect(snapshot).toHaveLength(MAX_DIAGNOSTIC_RECORDS);
    expect(snapshot.some((record) => record.missingFields?.includes('userId'))).toBe(
      false,
    );
    expect(snapshot[0]?.missingFields).toEqual(['chain']);
  });

  it('evicts oldest-first in insertion order', () => {
    let now = 0;
    const recorder = new DiagnosticRecorder({
      now: () => {
        now += 1;
        return now;
      },
      capacity: 3,
    });

    recorder.record({ code: 'schema_rejection' });
    recorder.record({ code: 'enrichment_failure' });
    recorder.record({ code: 'storage_failure' });
    recorder.record({ code: 'bridge_disconnected' });

    expect(recorder.snapshot().map((record) => record.receivedAt)).toEqual([2, 3, 4]);
    expect(recorder.snapshot().map((record) => record.code)).toEqual([
      'enrichment_failure',
      'storage_failure',
      'bridge_disconnected',
    ]);
  });

  it('clamps capacity to the 100-record hard cap', () => {
    const recorder = new DiagnosticRecorder({ now: () => 1, capacity: 500 });

    for (let index = 0; index < 120; index += 1) {
      recorder.record({ code: 'storage_failure' });
    }

    expect(recorder.snapshot()).toHaveLength(MAX_DIAGNOSTIC_RECORDS);
  });

  it('rejects invalid recorder options', () => {
    expect(() => new DiagnosticRecorder({ now: () => 1, capacity: 0 })).toThrowError(
      TypeError,
    );
    expect(() => new DiagnosticRecorder({ now: () => 1, capacity: 1.5 })).toThrowError(
      TypeError,
    );
    expect(() =>
      new DiagnosticRecorder({ now: () => 1, maxMissingFields: 0 }),
    ).toThrowError(TypeError);
  });

  it('rejects a clock that does not return a finite non-negative integer', () => {
    const recorder = new DiagnosticRecorder({ now: () => Number.NaN });

    expect(() => recorder.record({ code: 'storage_failure' })).toThrowError(TypeError);

    const negative = new DiagnosticRecorder({ now: () => -1 });

    expect(() => negative.record({ code: 'storage_failure' })).toThrowError(TypeError);
  });

  it('returns a defensive copy that cannot mutate internal state', () => {
    const recorder = new DiagnosticRecorder({ now: () => 1 });

    recorder.record({ code: 'storage_failure', missingFields: ['tokenAddress'] });

    const first = recorder.snapshot();
    const second = recorder.snapshot();

    expect(first).not.toBe(second);
    expect(first[0]).not.toBe(second[0]);

    (first as DiagnosticRecord[]).pop();
    (first[0]?.missingFields as string[] | undefined)?.push('userId');

    const third = recorder.snapshot();

    expect(third).toHaveLength(1);
    expect(third[0]?.missingFields).toEqual(['tokenAddress']);
  });

  it('never persists raw payloads, addresses, URLs, or secret values', () => {
    const recorder = new DiagnosticRecorder({ now: () => 1 });

    const hostile = {
      code: 'schema_rejection',
      messageType: 'https://evil.example/leak?token=secret',
      missingFields: [
        'tokenAddress',
        '0xdeadbeef00000000000000000000000000000000',
        'session=abc123',
        'authorization: Bearer topsecret',
        'userId',
      ],
      rawPayload: {
        comment: 'secret thesis',
        walletBalance: 999999,
        cookie: 'secret',
      },
    } as unknown as RecordDiagnosticInput;

    recorder.record(hostile);

    const snapshot = recorder.snapshot();

    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]).toEqual({
      code: 'schema_rejection',
      receivedAt: 1,
      missingFields: ['tokenAddress', 'userId'],
    });
    expect(snapshot[0]).not.toHaveProperty('messageType');
    expect(snapshot[0]).not.toHaveProperty('rawPayload');
    expect(snapshot[0]).not.toHaveProperty('cookie');
    expect(Object.keys(snapshot[0] ?? {}).sort()).toEqual([
      'code',
      'missingFields',
      'receivedAt',
    ]);
  });

  it('drops unknown and duplicate field names from missingFields', () => {
    const recorder = new DiagnosticRecorder({ now: () => 1 });

    recorder.record({
      code: 'schema_rejection',
      missingFields: ['evilKey', 'tokenAddress', 'tokenAddress', 'nonsense', 'chain'],
    });

    expect(recorder.snapshot()[0]?.missingFields).toEqual(['tokenAddress', 'chain']);
  });

  it('caps the number of recorded missing field names', () => {
    const recorder = new DiagnosticRecorder({ now: () => 1, maxMissingFields: 3 });

    recorder.record({
      code: 'schema_rejection',
      missingFields: ['id', 'tradeId', 'type', 'userId', 'userHandle'],
    });

    expect(recorder.snapshot()[0]?.missingFields).toEqual(['id', 'tradeId', 'type']);
  });

  it('drops non-string missingFields entries', () => {
    const recorder = new DiagnosticRecorder({ now: () => 1 });

    recorder.record({
      code: 'schema_rejection',
      missingFields: ['tokenAddress', 42, null] as unknown as readonly string[],
    });

    expect(recorder.snapshot()[0]?.missingFields).toEqual(['tokenAddress']);
  });

  it('omits messageType and missingFields when absent or fully rejected', () => {
    const recorder = new DiagnosticRecorder({ now: () => 1 });

    recorder.record({ code: 'storage_failure' });
    recorder.record({ code: 'storage_failure', messageType: 'invalid message type!' });
    recorder.record({ code: 'storage_failure', missingFields: ['notARealField'] });

    const snapshot = recorder.snapshot();

    for (const record of snapshot) {
      expect(record).not.toHaveProperty('messageType');
      expect(record).not.toHaveProperty('missingFields');
    }
  });

  it.each(['activity.ingest', 'connection.changed', 'trading_activity'])(
    'keeps a well-formed message type: %s',
    (messageType) => {
      const recorder = new DiagnosticRecorder({ now: () => 1 });

      recorder.record({ code: 'bridge_disconnected', messageType });

      expect(recorder.snapshot()[0]?.messageType).toBe(messageType);
    },
  );

  it.each(['UPPER', 'has space', 'https://evil.example/x', 'a/b', '', 'a'.repeat(65)])(
    'drops malformed or hostile message types: %s',
    (messageType) => {
      const recorder = new DiagnosticRecorder({ now: () => 1 });

      recorder.record({ code: 'bridge_disconnected', messageType });

      expect(recorder.snapshot()[0]).not.toHaveProperty('messageType');
    },
  );

  it('records the schema version of the rejected payload when known', () => {
    const recorder = new DiagnosticRecorder({ now: () => 1 });

    recorder.record({
      code: 'schema_rejection',
      schemaVersion: 1,
      messageType: 'activity.ingest',
    });

    expect(recorder.snapshot()[0]).toEqual({
      code: 'schema_rejection',
      receivedAt: 1,
      schemaVersion: 1,
      messageType: 'activity.ingest',
    });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null, 101])(
    'drops malformed or implausible schema versions: %p',
    (schemaVersion) => {
      const recorder = new DiagnosticRecorder({ now: () => 1 });

      recorder.record({
        code: 'schema_rejection',
        schemaVersion: schemaVersion as unknown as number,
      });

      expect(recorder.snapshot()[0]).not.toHaveProperty('schemaVersion');
    },
  );

  it('exposes the provisional-network-mapping diagnostic code', () => {
    expect(DIAGNOSTIC_CODES).toContain('provisional_network_mapping');

    const recorder = new DiagnosticRecorder({ now: () => 1 });

    recorder.record({ code: 'provisional_network_mapping' });

    expect(recorder.snapshot()[0]?.code).toBe('provisional_network_mapping');
  });
});
