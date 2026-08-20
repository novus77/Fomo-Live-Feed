import { buyFrame } from '../fixtures/fomo-frames';
import { normalizeActivity } from '../../src/fomo/normalize';

describe('normalizeActivity', () => {
  const sha256Hex = async (value: string) => {
    const bytes = new TextEncoder().encode(value);
    const digest = await crypto.subtle.digest('SHA-256', bytes);

    return Array.from(new Uint8Array(digest), (part) =>
      part.toString(16).padStart(2, '0'),
    ).join('');
  };

  it('normalizes a valid buy payload into the canonical trade event', async () => {
    const receivedAt = Date.parse('2026-08-20T08:15:35.000Z');

    const event = await normalizeActivity(buyFrame.payload, receivedAt);

    expect(event).toEqual({
      schemaVersion: 1,
      id: 'fomo:activity-1',
      source: 'fomo',
      sourceEventId: 'activity-1',
      sourceTradeId: 'trade-1',
      traderId: 'trader-1',
      traderHandle: 'alpha',
      traderName: 'Alpha Whale',
      traderAvatarUrl: 'https://example.com/avatar.png',
      chain: 'bsc',
      networkId: 56,
      tokenAddress: '0x020bfc650a365f8bb26819deaabf3e21291018b4',
      tokenSymbol: 'FOMO',
      tokenImageUrl: 'https://example.com/token.png',
      action: 'buy',
      usdAmount: 1250.5,
      marketCap: 4200000,
      price: 0.42,
      occurredAt: Date.parse('2026-08-20T08:15:30.000Z'),
      receivedAt,
    });
  });

  it('rejects payloads missing trader or token identity', async () => {
    await expect(
      normalizeActivity(
        {
          ...buyFrame.payload,
          userId: '',
        },
        Date.now(),
      ),
    ).rejects.toThrowError('Invalid Fomo activity');

    await expect(
      normalizeActivity(
        {
          ...buyFrame.payload,
          tokenAddress: '',
        },
        Date.now(),
      ),
    ).rejects.toThrowError('Invalid Fomo activity');
  });

  it.each([
    ['swap_buy', 'buy'],
    ['swap_sell', 'sell'],
    ['swap_withdraw', 'withdraw'],
    ['transfer_out', 'transfer'],
    ['thesis', 'thesis'],
  ])('maps %s into canonical action %s', async (type, action) => {
    const event = await normalizeActivity(
      {
        ...buyFrame.payload,
        type,
      },
      Date.now(),
    );

    expect(event.action).toBe(action);
  });

  it('maps unknown networks to unknown while preserving the networkId', async () => {
    const event = await normalizeActivity(
      {
        ...buyFrame.payload,
        id: 'activity-unknown-network',
        networkId: 999999,
      },
      Date.now(),
    );

    expect(event.chain).toBe('unknown');
    expect(event.networkId).toBe(999999);
  });

  it.each([
    [56, 'bsc', '0x020bfc650a365f8bb26819deaabf3e21291018b4'],
    [1, 'ethereum', '0x020bfc650a365f8bb26819deaabf3e21291018b4'],
    [8453, 'base', '0x020bfc650a365f8bb26819deaabf3e21291018b4'],
  ])(
    'maps networkId %s to %s and normalizes EVM address case for canonical display',
    async (networkId, chain, tokenAddress) => {
      const event = await normalizeActivity(
        {
          ...buyFrame.payload,
          id: `activity-network-${networkId}`,
          networkId,
          tokenAddress: '0x020BFC650A365F8BB26819DEAABF3E21291018B4',
        },
        Date.now(),
      );

      expect(event.chain).toBe(chain);
      expect(event.tokenAddress).toBe(tokenAddress);
    },
  );

  it('derives a deterministic fallback id when raw id is missing', async () => {
    const payload = {
      ...buyFrame.payload,
      id: undefined,
      tokenAddress: '0x020BFC650A365F8BB26819DEAABF3E21291018B4',
    };

    const event = await normalizeActivity(payload, Date.now());
    const expectedHash = await sha256Hex(
      [
        payload.userId,
        payload.type,
        String(payload.networkId),
        '0x020bfc650a365f8bb26819deaabf3e21291018b4',
        payload.createdAt,
        String(payload.usdAmount),
      ].join('|'),
    );

    expect(event.id).toBe(`fomo:${expectedHash}`);
    expect(event).not.toHaveProperty('sourceEventId');
  });

  it('keeps fallback ids stable for unknown-network EVM addresses regardless of mixed case', async () => {
    const mixedCasePayload = {
      ...buyFrame.payload,
      id: undefined,
      networkId: 999999,
      tokenAddress: '0x020BFC650A365F8BB26819DEAABF3E21291018B4',
    };
    const lowerCasePayload = {
      ...mixedCasePayload,
      tokenAddress: '0x020bfc650a365f8bb26819deaabf3e21291018b4',
    };

    const [mixedCaseEvent, lowerCaseEvent] = await Promise.all([
      normalizeActivity(mixedCasePayload, Date.now()),
      normalizeActivity(lowerCasePayload, Date.now()),
    ]);

    expect(mixedCaseEvent.chain).toBe('unknown');
    expect(mixedCaseEvent.tokenAddress).toBe(
      '0x020BFC650A365F8BB26819DEAABF3E21291018B4',
    );
    expect(lowerCaseEvent.tokenAddress).toBe(
      '0x020bfc650a365f8bb26819deaabf3e21291018b4',
    );
    expect(mixedCaseEvent.id).toBe(lowerCaseEvent.id);
  });

  it('extracts thesis text from structured or plain comments', async () => {
    const structured = await normalizeActivity(
      {
        ...buyFrame.payload,
        id: 'activity-thesis-object',
        type: 'thesis',
        comment: { comment: 'Conviction is compounding.' },
      },
      Date.now(),
    );

    const plain = await normalizeActivity(
      {
        ...buyFrame.payload,
        id: 'activity-thesis-string',
        type: 'thesis',
        comment: 'Narrative reversal.',
      },
      Date.now(),
    );

    expect(structured.thesis).toBe('Conviction is compounding.');
    expect(plain.thesis).toBe('Narrative reversal.');
  });

  it.each([
    [{ ...buyFrame.payload, profilePictureLink: 'not-a-url' }],
    [{ ...buyFrame.payload, profilePictureLink: 'http://example.com/avatar.png' }],
    [{ ...buyFrame.payload, profilePictureLink: 'javascript:alert(1)' }],
    [{ ...buyFrame.payload, profilePictureLink: 'data:text/plain,avatar' }],
    [{ ...buyFrame.payload, tokenImageUrl: 'http://example.com/token.png' }],
    [{ ...buyFrame.payload, tokenImageUrl: 'javascript:alert(1)' }],
    [{ ...buyFrame.payload, tokenImageUrl: 'data:text/plain,token' }],
    [{ ...buyFrame.payload, usdAmount: -1 }],
    [{ ...buyFrame.payload, marketCap: Number.NaN }],
    [{ ...buyFrame.payload, createdAt: 'definitely-not-a-date' }],
    [{ ...buyFrame.payload, networkId: '56' }],
    [{ ...buyFrame.payload, networkId: 56.5 }],
  ])('rejects invalid raw payloads: %j', async (payload) => {
    await expect(normalizeActivity(payload, Date.now())).rejects.toThrowError(
      'Invalid Fomo activity',
    );
  });

  it('omits missing optional fields instead of setting them to undefined', async () => {
    const event = await normalizeActivity(
      {
        type: 'swap_buy',
        userId: 'trader-minimal',
        userHandle: 'minimal',
        ticker: 'MIN',
        tokenAddress: '0xabcDEF0000000000000000000000000000000000',
        networkId: 1,
        createdAt: '2026-08-20T09:00:00.000Z',
      },
      Date.now(),
    );

    expect(event).toEqual({
      schemaVersion: 1,
      id: expect.any(String),
      source: 'fomo',
      traderId: 'trader-minimal',
      traderHandle: 'minimal',
      chain: 'ethereum',
      networkId: 1,
      tokenAddress: '0xabcdef0000000000000000000000000000000000',
      tokenSymbol: 'MIN',
      action: 'buy',
      occurredAt: Date.parse('2026-08-20T09:00:00.000Z'),
      receivedAt: expect.any(Number),
    });

    expect(event).not.toHaveProperty('traderName');
    expect(event).not.toHaveProperty('traderAvatarUrl');
    expect(event).not.toHaveProperty('tokenImageUrl');
    expect(event).not.toHaveProperty('usdAmount');
    expect(event).not.toHaveProperty('marketCap');
    expect(event).not.toHaveProperty('price');
    expect(event).not.toHaveProperty('sourceTradeId');
    expect(event).not.toHaveProperty('metricSnapshot');
  });

  it('preserves displayName verbatim when present, including empty string', async () => {
    const named = await normalizeActivity(
      {
        ...buyFrame.payload,
        id: 'activity-display-name-verbatim',
        displayName: '  Alpha Whale  ',
      },
      Date.now(),
    );

    const empty = await normalizeActivity(
      {
        ...buyFrame.payload,
        id: 'activity-display-name-empty',
        displayName: '',
      },
      Date.now(),
    );

    expect(named.traderName).toBe('  Alpha Whale  ');
    expect(empty).toHaveProperty('traderName', '');
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5])(
    'rejects invalid receivedAt values: %p',
    async (receivedAt) => {
      await expect(
        normalizeActivity(buyFrame.payload, receivedAt as number),
      ).rejects.toThrowError('Invalid Fomo activity');
    },
  );
});
