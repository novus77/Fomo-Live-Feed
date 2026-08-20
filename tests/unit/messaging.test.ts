import { describe, expect, it } from 'vitest';

import {
  activityCandidateEnvelopeSchema,
  eventQuerySchema,
  extensionMessageSchema,
  MAX_QUERY_LIMIT,
  parseExtensionMessage,
  PROTOCOL_VERSION,
  WINDOW_MESSAGE_NAMESPACE,
} from '../../src/messaging/protocol';
import type { ProtocolRejectionCode } from '../../src/messaging/protocol';
import {
  FOMO_ORIGINS,
  isAllowedFomoOrigin,
  isTrustedFomoSender,
  isTrustedFomoWindowMessage,
  isTrustedPopupSender,
  isTrustedSenderForMessage,
  trustClassForMessageType,
} from '../../src/messaging/guards';
import type { MessageSenderLike } from '../../src/messaging/guards';

const REJECTION_CODES: readonly ProtocolRejectionCode[] = [
  'not-object',
  'missing-protocol-version',
  'unsupported-protocol-version',
  'missing-type',
  'unknown-type',
  'invalid-payload',
];

const validActivityIngest = {
  protocolVersion: 1,
  type: 'activity.ingest',
  payload: { id: 'activity-1', type: 'swap_buy', userId: 'trader-1' },
} as const;

describe('protocol', () => {
  describe('parseExtensionMessage', () => {
    it('accepts a valid activity.ingest message and preserves the untrusted payload verbatim', () => {
      const payload = {
        id: 'activity-1',
        type: 'swap_buy',
        userId: 'trader-1',
        nested: { deep: [1, 2, null] },
      };

      const result = parseExtensionMessage({
        protocolVersion: 1,
        type: 'activity.ingest',
        payload,
      });

      if (!result.ok) {
        throw new Error(`expected ok, got ${result.reason}`);
      }

      if (result.message.type !== 'activity.ingest') {
        throw new Error('expected an activity.ingest message');
      }

      expect(result.message.protocolVersion).toBe(1);
      expect(result.message.payload).toBe(payload);
    });

    it('accepts connection.changed with explicit connected/authenticated flags and a non-negative integer timestamp', () => {
      for (const message of [
        { protocolVersion: 1, type: 'connection.changed', payload: { connected: true, authenticated: true, at: 1_800_000_000_000 } },
        { protocolVersion: 1, type: 'connection.changed', payload: { connected: false, authenticated: false, at: 0 } },
        { protocolVersion: 1, type: 'connection.changed', payload: { connected: false, authenticated: true, at: 0 } },
      ]) {
        expect(parseExtensionMessage(message)).toMatchObject({ ok: true });
      }
    });

    it('rejects connection.changed without the explicit authenticated flag (BLOCKING 2)', () => {
      expect(
        parseExtensionMessage({
          protocolVersion: 1,
          type: 'connection.changed',
          payload: { connected: true, at: 1_800_000_000_000 },
        }),
      ).toEqual({ ok: false, reason: 'invalid-payload' });
    });

    it('accepts diagnostics.record with a redacted schema-rejection payload', () => {
      const result = parseExtensionMessage({
        protocolVersion: 1,
        type: 'diagnostics.record',
        payload: { code: 'schema_rejection', messageType: 'events.query', schemaVersion: 1 },
      });

      if (!result.ok) {
        throw new Error('expected ok, got ' + result.reason);
      }

      expect(result.message).toMatchObject({
        protocolVersion: 1,
        type: 'diagnostics.record',
        payload: { code: 'schema_rejection', messageType: 'events.query', schemaVersion: 1 },
      });
    });

    it('rejects diagnostics.record with an unknown code or smuggled fields', () => {
      // The transport only bounds shape; unknown FIELD NAMES inside
      // missingFields are allowed through so the worker's DiagnosticRecorder
      // can apply its own allowlist sanitization (see diagnostics.test.ts).
      for (const payload of [
        { code: 'not-a-code' },
        { code: 'schema_rejection', extra: 1 },
        { code: 'schema_rejection', messageType: 'EVIL!'.repeat(20) },
        { code: 'schema_rejection', missingFields: 'not-an-array' },
      ]) {
        expect(
          parseExtensionMessage({
            protocolVersion: 1,
            type: 'diagnostics.record',
            payload,
          }),
        ).toEqual({ ok: false, reason: 'invalid-payload' });
      }

      expect(
        parseExtensionMessage({
          protocolVersion: 1,
          type: 'diagnostics.record',
          payload: { code: 'schema_rejection', missingFields: ['secret-cookie'] },
        }),
      ).toMatchObject({ ok: true });
    });

    it('accepts events.query with a full query and trims string fields', () => {
      const result = parseExtensionMessage({
        protocolVersion: 1,
        type: 'events.query',
        payload: {
          limit: 50,
          beforeOccurredAt: 1_800_000_000_000,
          beforeId: 'fomo:abc',
          traderId: '  trader-1  ',
          chain: 'solana',
          tokenAddress: '  0xabc  ',
          unreadOnly: true,
          search: '  alpha whale  ',
        },
      });

      if (!result.ok) {
        throw new Error(`expected ok, got ${result.reason}`);
      }

      if (result.message.type !== 'events.query') {
        throw new Error('expected an events.query message');
      }

      expect(result.message.payload).toEqual({
        limit: 50,
        beforeOccurredAt: 1_800_000_000_000,
        beforeId: 'fomo:abc',
        traderId: 'trader-1',
        chain: 'solana',
        tokenAddress: '0xabc',
        unreadOnly: true,
        search: 'alpha whale',
      });
    });

    it('accepts events.markRead with ids and a timestamp', () => {
      const result = parseExtensionMessage({
        protocolVersion: 1,
        type: 'events.markRead',
        payload: { ids: ['fomo:one', 'fomo:two'], at: 1_800_000_000_000 },
      });

      expect(result).toMatchObject({ ok: true });
    });

    it('accepts preferences.changed without a payload', () => {
      const result = parseExtensionMessage({ protocolVersion: 1, type: 'preferences.changed' });

      if (!result.ok) {
        throw new Error(`expected ok, got ${result.reason}`);
      }

      expect(result.message).toEqual({ protocolVersion: 1, type: 'preferences.changed' });
    });

    it('accepts connection.query without a payload and rejects one with extra fields', () => {
      const result = parseExtensionMessage({ protocolVersion: 1, type: 'connection.query' });

      if (!result.ok) {
        throw new Error(`expected ok, got ${result.reason}`);
      }

      expect(result.message).toEqual({ protocolVersion: 1, type: 'connection.query' });
      expect(
        parseExtensionMessage({ protocolVersion: 1, type: 'connection.query', payload: {} }),
      ).toEqual({ ok: false, reason: 'invalid-payload' });
    });

    it('accepts only closed, redacted pipeline health messages', () => {
      expect(parseExtensionMessage({
        protocolVersion: 1,
        type: 'pipeline.healthEvent',
        payload: { type: 'frame.received', at: 1_000 },
      })).toMatchObject({ ok: true });
      expect(parseExtensionMessage({ protocolVersion: 1, type: 'pipeline.healthQuery' }))
        .toMatchObject({ ok: true });

      for (const payload of [
        { type: 'frame.received', at: -1 },
        { type: 'activity.rejected', code: 'secret', at: 1_000 },
        { type: 'frame.received', at: 1_000, payload: 'raw frame' },
      ]) {
        expect(parseExtensionMessage({
          protocolVersion: 1,
          type: 'pipeline.healthEvent',
          payload,
        })).toEqual({ ok: false, reason: 'invalid-payload' });
      }
    });

    it('accepts the worker activity.broadcast envelope with an unknown event and a toast flag', () => {
      const event = { schemaVersion: 1, id: 'fomo:activity-1', traderId: 'trader-1' };
      const result = parseExtensionMessage({
        protocolVersion: 1,
        type: 'activity.broadcast',
        payload: { event, toast: true },
      });

      if (!result.ok) {
        throw new Error(`expected ok, got ${result.reason}`);
      }

      if (result.message.type !== 'activity.broadcast') {
        throw new Error('expected an activity.broadcast message');
      }

      expect(result.message.payload.toast).toBe(true);
      expect(result.message.payload.event).toEqual(event);
    });

    it.each([
      [
        {
          protocolVersion: 1,
          type: 'activity.broadcast',
          payload: { event: {} },
        },
      ],
      [
        {
          protocolVersion: 1,
          type: 'activity.broadcast',
          payload: { event: {}, toast: 'yes' },
        },
      ],
      [
        {
          protocolVersion: 1,
          type: 'activity.broadcast',
          payload: { toast: true },
        },
      ],
      [
        {
          protocolVersion: 1,
          type: 'activity.broadcast',
          payload: { event: undefined, toast: true },
        },
      ],
      [
        {
          protocolVersion: 1,
          type: 'activity.broadcast',
          payload: { event: {}, toast: true, extra: 1 },
        },
      ],
    ])('rejects an invalid activity.broadcast payload: %j', (message) => {
      expect(parseExtensionMessage(message)).toEqual({ ok: false, reason: 'invalid-payload' });
    });

    it.each([
      [null],
      [undefined],
      ['activity.ingest'],
      [42],
      [true],
      [[]],
      [[1, 2, 3]],
    ])('rejects non-object input: %p', (input) => {
      const result = parseExtensionMessage(input);
      expect(result).toEqual({ ok: false, reason: 'not-object' });
    });

    it('rejects messages without a protocolVersion', () => {
      const result = parseExtensionMessage({ type: 'activity.ingest', payload: {} });
      expect(result).toEqual({ ok: false, reason: 'missing-protocol-version' });
    });

    it.each([[2], [0], ['1'], [1.5], [null], [true]])(
      'rejects unsupported protocolVersion %p',
      (protocolVersion) => {
        const result = parseExtensionMessage({
          protocolVersion,
          type: 'activity.ingest',
          payload: {},
        });
        expect(result).toEqual({ ok: false, reason: 'unsupported-protocol-version' });
      },
    );

    it('rejects messages without a type', () => {
      expect(parseExtensionMessage({ protocolVersion: 1 })).toEqual({
        ok: false,
        reason: 'missing-type',
      });
      expect(parseExtensionMessage({ protocolVersion: 1, type: '' })).toEqual({
        ok: false,
        reason: 'missing-type',
      });
    });

    it.each([['nope'], ['activity.ingest.evil'], ['ACTIVITY.INGEST'], ['trading_activity']])(
      'rejects unknown message type %s',
      (type) => {
        const result = parseExtensionMessage({ protocolVersion: 1, type, payload: {} });
        expect(result).toEqual({ ok: false, reason: 'unknown-type' });
      },
    );

    it.each([
      [{ protocolVersion: 1, type: 'activity.ingest' }],
      [{ protocolVersion: 1, type: 'activity.ingest', payload: undefined }],
      [{ protocolVersion: 1, type: 'connection.changed', payload: { at: 1 } }],
      [{ protocolVersion: 1, type: 'connection.changed', payload: { connected: 'yes', at: 1 } }],
      [{ protocolVersion: 1, type: 'connection.changed', payload: { connected: true, at: -1 } }],
      [{ protocolVersion: 1, type: 'connection.changed', payload: { connected: true, at: 1.5 } }],
      [{ protocolVersion: 1, type: 'connection.changed', payload: { connected: true, authenticated: true } }],
      [{ protocolVersion: 1, type: 'connection.changed', payload: { connected: true, authenticated: 'yes', at: 1 } }],
      [{ protocolVersion: 1, type: 'events.query', payload: { limit: 0 } }],
      [{ protocolVersion: 1, type: 'events.query', payload: {} }],
      [{ protocolVersion: 1, type: 'events.markRead', payload: { ids: 'not-an-array', at: 1 } }],
      [{ protocolVersion: 1, type: 'events.markRead', payload: { ids: [''], at: 1 } }],
      [{ protocolVersion: 1, type: 'events.markRead', payload: { ids: [], at: -5 } }],
      [
        {
          protocolVersion: 1,
          type: 'events.markRead',
          payload: { ids: Array.from({ length: 1_001 }, (_, index) => 'id-' + index), at: 1 },
        },
      ],
      [{ protocolVersion: 1, type: 'preferences.changed', payload: {} }],
    ])('rejects an invalid payload: %j', (message) => {
      expect(parseExtensionMessage(message)).toEqual({ ok: false, reason: 'invalid-payload' });
    });

    it('rejects extra envelope properties so senders cannot smuggle fields', () => {
      const result = parseExtensionMessage({
        ...validActivityIngest,
        extra: 'smuggled',
      });

      expect(result).toEqual({ ok: false, reason: 'invalid-payload' });
    });

    it('rejects extra payload properties on structured payloads', () => {
      const messages = [
        {
          protocolVersion: 1,
          type: 'connection.changed',
          payload: { connected: true, at: 1, extra: 1 },
        },
        {
          protocolVersion: 1,
          type: 'events.query',
          payload: { limit: 50, extra: 1 },
        },
        {
          protocolVersion: 1,
          type: 'events.markRead',
          payload: { ids: ['fomo:one'], at: 1, extra: 1 },
        },
      ];

      for (const message of messages) {
        expect(parseExtensionMessage(message)).toEqual({
          ok: false,
          reason: 'invalid-payload',
        });
        expect(extensionMessageSchema.safeParse(message).success).toBe(false);
      }
    });

    it('reports only closed-set reason codes and never echoes the rejected payload', () => {
      const hostile = [
        { protocolVersion: 1, type: 'activity.ingest', payload: { secret: 'hunter2' }, extra: true },
        { protocolVersion: 1, type: 'events.query', payload: { limit: 50, evil: 'field' } },
        { protocolVersion: 2, type: 'events.markRead', payload: { ids: ['x'], at: 1 } },
        null,
        'activity.ingest',
        { type: 'connection.changed' },
      ];

      for (const input of hostile) {
        const result = parseExtensionMessage(input);
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(REJECTION_CODES).toContain(result.reason);
          expect(result.reason).not.toContain('hunter2');
          expect(result.reason).not.toContain('secret');
        }
      }
    });
  });

  describe('EventQuery validation', () => {
    it('enforces a positive integer limit with an upper bound', () => {
      for (const limit of [1, MAX_QUERY_LIMIT]) {
        expect(eventQuerySchema.safeParse({ limit }).success).toBe(true);
      }

      for (const limit of [0, -1, 1.5, MAX_QUERY_LIMIT + 1]) {
        expect(eventQuerySchema.safeParse({ limit }).success).toBe(false);
      }
      expect(eventQuerySchema.safeParse({ limit: '50' }).success).toBe(false);
    });

    it('accepts an optional non-negative integer beforeOccurredAt', () => {
      expect(eventQuerySchema.safeParse({ limit: 50, beforeOccurredAt: 0 }).success).toBe(true);
      expect(eventQuerySchema.safeParse({ limit: 50, beforeOccurredAt: 1_800_000_000_000 }).success).toBe(true);
      expect(eventQuerySchema.safeParse({ limit: 50, beforeOccurredAt: -1 }).success).toBe(false);
      expect(eventQuerySchema.safeParse({ limit: 50, beforeOccurredAt: 1.5 }).success).toBe(false);
    });

    it('requires beforeOccurredAt when a cursor id is supplied', () => {
      expect(eventQuerySchema.safeParse({ limit: 50, beforeId: 'fomo:abc' }).success).toBe(false);
      expect(
        eventQuerySchema.safeParse({ limit: 50, beforeOccurredAt: 1, beforeId: 'fomo:abc' }).success,
      ).toBe(true);
    });

    it('validates optional filter fields strictly', () => {
      expect(eventQuerySchema.safeParse({ limit: 50, traderId: 'trader-1' }).success).toBe(true);
      expect(eventQuerySchema.safeParse({ limit: 50, unreadOnly: true }).success).toBe(true);
      expect(eventQuerySchema.safeParse({ limit: 50, unreadOnly: 'yes' }).success).toBe(false);
      expect(eventQuerySchema.safeParse({ limit: 50, chain: 'solana' }).success).toBe(true);
      expect(eventQuerySchema.safeParse({ limit: 50, chain: 'unknown' }).success).toBe(true);
      expect(eventQuerySchema.safeParse({ limit: 50, chain: 'polygon' }).success).toBe(false);
      expect(eventQuerySchema.safeParse({ limit: 50, tokenAddress: '0xabc' }).success).toBe(true);
      expect(eventQuerySchema.safeParse({ limit: 50, tokenAddress: '  ' }).success).toBe(false);
    });

    it('trims and bounds the optional search string', () => {
      const parsed = eventQuerySchema.parse({ limit: 50, search: '  alpha whale  ' });
      expect(parsed.search).toBe('alpha whale');

      expect(eventQuerySchema.safeParse({ limit: 50, search: '   ' }).success).toBe(false);
      expect(eventQuerySchema.safeParse({ limit: 50, search: 'a'.repeat(100) }).success).toBe(true);
      expect(eventQuerySchema.safeParse({ limit: 50, search: 'a'.repeat(101) }).success).toBe(false);
    });

    it('rejects unknown query fields', () => {
      expect(eventQuerySchema.safeParse({ limit: 50, evil: 'field' }).success).toBe(false);
    });
  });

  describe('window activity candidate envelope', () => {
    it('exports the namespace constant so the interceptor and bridge cannot drift', () => {
      expect(WINDOW_MESSAGE_NAMESPACE).toBe('fomo-live-feed');
      expect(PROTOCOL_VERSION).toBe(1);
    });

    it('accepts a valid activity.candidate envelope with an unknown payload', () => {
      const envelope = {
        namespace: 'fomo-live-feed',
        protocolVersion: 1,
        type: 'activity.candidate',
        payload: { type: 'message', payload: { id: 'activity-1' } },
      };

      expect(activityCandidateEnvelopeSchema.safeParse(envelope).success).toBe(true);
    });

    it.each([
      [{ namespace: 'other-namespace', protocolVersion: 1, type: 'activity.candidate', payload: {} }],
      [{ namespace: 'fomo-live-feed', protocolVersion: 2, type: 'activity.candidate', payload: {} }],
      [{ namespace: 'fomo-live-feed', protocolVersion: 1, type: 'other.type', payload: {} }],
      [{ namespace: 'fomo-live-feed', protocolVersion: 1, type: 'activity.candidate' }],
      [{ namespace: 'fomo-live-feed', protocolVersion: 1, type: 'activity.candidate', payload: undefined }],
      [{ namespace: 'fomo-live-feed', protocolVersion: 1, type: 'activity.candidate', payload: {}, extra: 1 }],
    ])('rejects an invalid candidate envelope: %j', (envelope) => {
      expect(activityCandidateEnvelopeSchema.safeParse(envelope).success).toBe(false);
    });
  });
});

describe('guards', () => {
  describe('isTrustedFomoSender', () => {
    it('accepts tab URLs whose parsed origin is exactly a Fomo origin', () => {
      expect(isTrustedFomoSender({ tab: { url: 'https://fomo.family/' } })).toBe(true);
      expect(isTrustedFomoSender({ tab: { url: 'https://fomo.family/leaderboard' } })).toBe(true);
      expect(isTrustedFomoSender({ tab: { url: 'https://www.fomo.family/' } })).toBe(true);
      expect(isTrustedFomoSender({ tab: { url: 'https://fomo.family:443/' } })).toBe(true);
    });

    it('rejects missing senders', () => {
      expect(isTrustedFomoSender(undefined)).toBe(false);
      expect(isTrustedFomoSender(null)).toBe(false);
    });

    it('rejects senders without a tab or tab url', () => {
      expect(isTrustedFomoSender({})).toBe(false);
      expect(isTrustedFomoSender({ id: 'ext-1' })).toBe(false);
      expect(isTrustedFomoSender({ tab: {} })).toBe(false);
    });

    it('rejects senders whose tab url is not a string', () => {
      const sender = { tab: { url: 42 } } as unknown as MessageSenderLike;
      expect(isTrustedFomoSender(sender)).toBe(false);
    });

    it('rejects blob: URLs that impersonate a trusted Fomo origin', () => {
      expect(
        isTrustedFomoSender({ tab: { url: 'blob:https://fomo.family/abc' } }),
      ).toBe(false);
      expect(
        isTrustedFomoSender({ tab: { url: 'blob:https://www.fomo.family/xyz' } }),
      ).toBe(false);
    });

    it('rejects filesystem: URLs that impersonate a trusted Fomo origin', () => {
      expect(
        isTrustedFomoSender({
          tab: { url: 'filesystem:https://fomo.family/temporary/x' },
        }),
      ).toBe(false);
    });

    it.each([
      ['https://fomo.family.evil.com/'],
      ['https://evil-fomo.family/'],
      ['https://sub.fomo.family/'],
      ['https://fomo.family@evil.com/'],
      ['https://fomo.family:8443/'],
      ['https://www.fomo.family:8080/x'],
      ['http://fomo.family/'],
      ['http://www.fomo.family/'],
      ['https://example.com/'],
      ['https://fomo.family.org/'],
      ['https://'],
      ['not a url'],
      [''],
      ['fomo.family'],
      ['//fomo.family/'],
      ['about:blank'],
    ])('rejects spoofed or invalid tab url %s', (url) => {
      expect(isTrustedFomoSender({ tab: { url } })).toBe(false);
    });

    it('rejects senders from other extensions when an expected extension id is supplied', () => {
      expect(
        isTrustedFomoSender({ id: 'other-extension', tab: { url: 'https://fomo.family/' } }, 'expected-extension'),
      ).toBe(false);
      expect(isTrustedFomoSender({ tab: { url: 'https://fomo.family/' } }, 'expected-extension')).toBe(false);
    });

    it('accepts the expected extension id when supplied', () => {
      expect(
        isTrustedFomoSender({ id: 'expected-extension', tab: { url: 'https://fomo.family/' } }, 'expected-extension'),
      ).toBe(true);
    });

    it('ignores the sender id when no expected extension id is supplied', () => {
      expect(isTrustedFomoSender({ id: 'unrelated-extension', tab: { url: 'https://fomo.family/' } })).toBe(true);
    });
  });

  describe('isTrustedFomoWindowMessage', () => {
    const candidate = {
      namespace: 'fomo-live-feed',
      protocolVersion: 1,
      type: 'activity.candidate',
      payload: { type: 'message', payload: { id: 'activity-1' } },
    };

    it('accepts a valid candidate posted by the window itself on a Fomo page', () => {
      expect(isTrustedFomoWindowMessage({ source: window, data: candidate }, 'https://fomo.family')).toBe(true);
      expect(isTrustedFomoWindowMessage({ source: window, data: candidate }, 'https://www.fomo.family')).toBe(true);
    });

    it('rejects messages from a different source', () => {
      const otherWindow = {} as Window;
      expect(isTrustedFomoWindowMessage({ source: otherWindow, data: candidate }, 'https://fomo.family')).toBe(false);
      expect(isTrustedFomoWindowMessage({ source: null, data: candidate }, 'https://fomo.family')).toBe(false);
      expect(isTrustedFomoWindowMessage({ source: undefined, data: candidate }, 'https://fomo.family')).toBe(false);
    });

    it.each([
      ['https://evil.com'],
      ['http://fomo.family'],
      ['https://fomo.family.evil.com'],
      ['https://fomo.family:8443'],
      ['null'],
    ])('rejects messages on a non-Fomo page origin %s', (origin) => {
      expect(isTrustedFomoWindowMessage({ source: window, data: candidate }, origin)).toBe(false);
    });

    it('rejects a wrong namespace', () => {
      const data = { ...candidate, namespace: 'other-namespace' };
      expect(isTrustedFomoWindowMessage({ source: window, data }, 'https://fomo.family')).toBe(false);
    });

    it('rejects a wrong protocol version', () => {
      const data = { ...candidate, protocolVersion: 2 };
      expect(isTrustedFomoWindowMessage({ source: window, data }, 'https://fomo.family')).toBe(false);
    });

    it('rejects a wrong message type', () => {
      const data = { ...candidate, type: 'other.type' };
      expect(isTrustedFomoWindowMessage({ source: window, data }, 'https://fomo.family')).toBe(false);
    });

    it('rejects a missing or undefined payload', () => {
      const withoutPayload = { namespace: 'fomo-live-feed', protocolVersion: 1, type: 'activity.candidate' };
      const undefinedPayload = { ...candidate, payload: undefined };
      expect(isTrustedFomoWindowMessage({ source: window, data: withoutPayload }, 'https://fomo.family')).toBe(false);
      expect(isTrustedFomoWindowMessage({ source: window, data: undefinedPayload }, 'https://fomo.family')).toBe(false);
    });

    it('rejects extra envelope fields', () => {
      const data = { ...candidate, extra: 'smuggled' };
      expect(isTrustedFomoWindowMessage({ source: window, data }, 'https://fomo.family')).toBe(false);
    });

    it('rejects when the real window origin is not a Fomo origin', () => {
      expect(isTrustedFomoWindowMessage({ source: window, data: candidate })).toBe(false);
    });
  });

  describe('allowed Fomo origin catalog', () => {
    it('declares exactly the two HTTPS Fomo origins in one place', () => {
      expect(FOMO_ORIGINS).toEqual(['https://fomo.family', 'https://www.fomo.family']);
    });

    it('matches only exact origins', () => {
      expect(isAllowedFomoOrigin('https://fomo.family')).toBe(true);
      expect(isAllowedFomoOrigin('https://www.fomo.family')).toBe(true);
      expect(isAllowedFomoOrigin('https://fomo.family/')).toBe(false);
      expect(isAllowedFomoOrigin('http://fomo.family')).toBe(false);
      expect(isAllowedFomoOrigin('https://fomo.family:8443')).toBe(false);
      expect(isAllowedFomoOrigin('https://fomo.family.evil.com')).toBe(false);
      expect(isAllowedFomoOrigin('https://evil.com')).toBe(false);
    });
  });

  describe('trustClassForMessageType', () => {
    it('requires the Fomo content-script class for activity and connection messages', () => {
      expect(trustClassForMessageType('activity.ingest')).toBe('fomo-content-script');
      expect(trustClassForMessageType('connection.changed')).toBe('fomo-content-script');
      expect(trustClassForMessageType('pipeline.healthEvent')).toBe('fomo-content-script');
    });

    it('requires the privileged UI class for popup-originated messages', () => {
      expect(trustClassForMessageType('events.query')).toBe('privileged-ui-page');
      expect(trustClassForMessageType('events.markRead')).toBe('privileged-ui-page');
      expect(trustClassForMessageType('preferences.changed')).toBe('privileged-ui-page');
      expect(trustClassForMessageType('connection.query')).toBe('privileged-ui-page');
      expect(trustClassForMessageType('diagnostics.record')).toBe('privileged-ui-page');
      expect(trustClassForMessageType('pipeline.healthQuery')).toBe('privileged-ui-page');
    });

    it('assigns no inbound sender class to the worker-originated broadcast', () => {
      // activity.broadcast travels worker -> overlay only. It is never a
      // legitimate INBOUND message at the worker, so no sender class may be
      // trusted for it: neither a Fomo tab nor the popup can spoof a
      // broadcast into the worker. The overlay validates broadcasts with
      // parseExtensionMessage plus its own field-by-field re-validation.
      expect(trustClassForMessageType('activity.broadcast')).toBeNull();
    });

    it.each(['activity.candidate', 'nope', '', 'EVENTS.QUERY', 'events.query.v2'])(
      'returns null for messages outside the extension protocol: %s',
      (messageType) => {
        expect(trustClassForMessageType(messageType)).toBeNull();
      },
    );
  });

  describe('isTrustedPopupSender', () => {
    const EXTENSION_ID = 'our-extension-id';

    it('accepts a tabless sender with our extension id and no url', () => {
      expect(isTrustedPopupSender({ id: EXTENSION_ID }, EXTENSION_ID)).toBe(true);
    });

    it('accepts a tabless sender whose url is our own chrome-extension page', () => {
      expect(
        isTrustedPopupSender(
          { id: EXTENSION_ID, url: 'chrome-extension://' + EXTENSION_ID + '/popup/index.html' },
          EXTENSION_ID,
        ),
      ).toBe(true);
    });

    it('rejects missing senders and senders without our extension id', () => {
      expect(isTrustedPopupSender(undefined, EXTENSION_ID)).toBe(false);
      expect(isTrustedPopupSender(null, EXTENSION_ID)).toBe(false);
      expect(isTrustedPopupSender({}, EXTENSION_ID)).toBe(false);
      expect(isTrustedPopupSender({ id: 'other-extension' }, EXTENSION_ID)).toBe(false);
    });

    it('never accepts a content-script sender that carries a tab', () => {
      expect(
        isTrustedPopupSender(
          { id: EXTENSION_ID, tab: { url: 'https://fomo.family/' } },
          EXTENSION_ID,
        ),
      ).toBe(false);
      expect(
        isTrustedPopupSender(
          { id: EXTENSION_ID, url: 'chrome-extension://' + EXTENSION_ID + '/x.html', tab: { url: 'https://fomo.family/' } },
          EXTENSION_ID,
        ),
      ).toBe(false);
    });

    it.each([
      ['https://evil.com/'],
      ['chrome-extension://other-extension/popup/index.html'],
      ['blob:https://fomo.family/abc'],
      ['not a url'],
      [''],
    ])('rejects a present sender url that is not our chrome-extension page: %s', (url) => {
      expect(isTrustedPopupSender({ id: EXTENSION_ID, url }, EXTENSION_ID)).toBe(false);
    });
  });

  describe('isTrustedSenderForMessage matrix', () => {
    const EXTENSION_ID = 'our-extension-id';
    const SENDER_BY_KIND: Readonly<Record<string, MessageSenderLike | null>> = {
      'fomo tab': { id: EXTENSION_ID, tab: { url: 'https://fomo.family/' } },
      'other-site tab': { id: EXTENSION_ID, tab: { url: 'https://evil.com/' } },
      'own popup': { id: EXTENSION_ID },
      'own popup with url': {
        id: EXTENSION_ID,
        url: 'chrome-extension://' + EXTENSION_ID + '/popup/index.html',
      },
      'other extension': { id: 'other-extension' },
      'no sender': null,
    };

    it.each([
      ['activity.ingest', 'fomo tab', true],
      ['activity.ingest', 'other-site tab', false],
      ['activity.ingest', 'own popup', false],
      ['activity.ingest', 'own popup with url', false],
      ['activity.ingest', 'other extension', false],
      ['activity.ingest', 'no sender', false],
      ['connection.changed', 'fomo tab', true],
      ['connection.changed', 'other-site tab', false],
      ['connection.changed', 'own popup', false],
      ['connection.changed', 'own popup with url', false],
      ['connection.changed', 'other extension', false],
      ['connection.changed', 'no sender', false],
      ['events.query', 'fomo tab', false],
      ['events.query', 'other-site tab', false],
      ['events.query', 'own popup', true],
      ['events.query', 'own popup with url', true],
      ['events.query', 'other extension', false],
      ['events.query', 'no sender', false],
      ['events.markRead', 'fomo tab', false],
      ['events.markRead', 'other-site tab', false],
      ['events.markRead', 'own popup', true],
      ['events.markRead', 'own popup with url', true],
      ['events.markRead', 'other extension', false],
      ['events.markRead', 'no sender', false],
      ['preferences.changed', 'fomo tab', false],
      ['preferences.changed', 'other-site tab', false],
      ['preferences.changed', 'own popup', true],
      ['preferences.changed', 'own popup with url', true],
      ['preferences.changed', 'other extension', false],
      ['preferences.changed', 'no sender', false],
      ['connection.query', 'fomo tab', false],
      ['connection.query', 'other-site tab', false],
      ['connection.query', 'own popup', true],
      ['connection.query', 'own popup with url', true],
      ['connection.query', 'other extension', false],
      ['connection.query', 'no sender', false],
    ])(
      'routes %s from a %s sender with the expected verdict %s',
      (messageType, senderKind, expected) => {
        const sender = SENDER_BY_KIND[senderKind];

        expect(
          isTrustedSenderForMessage(sender ?? null, messageType, EXTENSION_ID),
        ).toBe(expected);
      },
    );
  });
});
