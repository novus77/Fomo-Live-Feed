import {
  PROTOCOL_VERSION,
  parseExtensionMessage,
} from '../../src/messaging/protocol';
import {
  isAllowedPumpOrigin,
  isTrustedPumpSender,
  isTrustedSenderForMessage,
} from '../../src/messaging/guards';

describe('Pump runtime protocol', () => {
  it('accepts bounded lease, batch, status, and page-hidden messages', () => {
    const messages = [
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'pump.lease.request',
        payload: { at: 1_000 },
      },
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'pump.batch',
        payload: {
          epoch: 2,
          delivery: 'live',
          items: [{ kind: 'trade' }],
          watermark: '1399811149:tx',
          recentKeys: ['1399811149:tx'],
          possibleGap: false,
          at: 1_001,
        },
      },
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'pump.status',
        payload: { epoch: 2, status: 'live', at: 1_002, backoffLevel: 0 },
      },
      {
        protocolVersion: PROTOCOL_VERSION,
        type: 'pump.pageHidden',
        payload: { epoch: 2, at: 1_003 },
      },
    ];

    for (const message of messages) {
      expect(parseExtensionMessage(message)).toEqual({ ok: true, message });
    }
  });

  it('rejects oversized batches, state, and unknown status values', () => {
    expect(parseExtensionMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: 'pump.batch',
      payload: {
        epoch: 1,
        delivery: 'live',
        items: Array.from({ length: 101 }, () => ({})),
        recentKeys: [],
        possibleGap: false,
        at: 1,
      },
    }).ok).toBe(false);

    expect(parseExtensionMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: 'pump.batch',
      payload: {
        epoch: 1,
        delivery: 'live',
        items: [],
        watermark: 'x'.repeat(513),
        recentKeys: [],
        possibleGap: false,
        at: 1,
      },
    }).ok).toBe(false);

    expect(parseExtensionMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: 'pump.status',
      payload: { epoch: 1, status: 'invented', at: 1, backoffLevel: 0 },
    }).ok).toBe(false);
  });
});

describe('Pump sender guards', () => {
  const extensionId = 'extension-id';

  it.each(['https://pump.fun', 'https://www.pump.fun'])('allows exact HTTPS origin %s', (origin) => {
    expect(isAllowedPumpOrigin(origin)).toBe(true);
    const sender = { id: extensionId, tab: { id: 7, url: `${origin}/board` } };
    expect(isTrustedPumpSender(sender, extensionId)).toBe(true);
    expect(isTrustedSenderForMessage(sender, 'pump.batch', extensionId)).toBe(true);
  });

  it.each([
    'http://pump.fun/',
    'https://evil.pump.fun/',
    'https://pump.fun.evil.example/',
    'blob:https://pump.fun/id',
    'https://pump.fun:444/',
  ])('rejects Pump look-alike sender %s', (url) => {
    const sender = { id: extensionId, tab: { id: 7, url } };
    expect(isTrustedPumpSender(sender, extensionId)).toBe(false);
    expect(isTrustedSenderForMessage(sender, 'pump.batch', extensionId)).toBe(false);
  });

  it('does not allow Fomo content scripts to send Pump messages', () => {
    const sender = { id: extensionId, tab: { id: 7, url: 'https://fomo.family/' } };
    expect(isTrustedSenderForMessage(sender, 'pump.batch', extensionId)).toBe(false);
  });
});
