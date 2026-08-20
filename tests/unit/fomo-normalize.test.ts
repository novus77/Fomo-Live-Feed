import { buyFrame } from '../fixtures/fomo-frames';
import { normalizeActivity } from '../../src/fomo/normalize';
import {
  getNetworkMapping,
  mapNetworkId,
} from '../../src/fomo/network-map';

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

  it('normalizes unknown-network uppercase 0X EVM addresses canonically and keeps fallback ids stable', async () => {
    const mixedCasePayload = {
      ...buyFrame.payload,
      id: undefined,
      networkId: 999999,
      tokenAddress: '0X020BFC650A365F8BB26819DEAABF3E21291018B4',
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
      '0x020bfc650a365f8bb26819deaabf3e21291018b4',
    );
    expect(lowerCaseEvent.tokenAddress).toBe(
      '0x020bfc650a365f8bb26819deaabf3e21291018b4',
    );
    expect(mixedCaseEvent.id).toBe(lowerCaseEvent.id);
  });

  it('keeps non-EVM token addresses case-sensitive for fallback ids', async () => {
    const upperCasePayload = {
      ...buyFrame.payload,
      id: undefined,
      networkId: 999999,
      tokenAddress: 'AbCdEfGh1234567890',
    };
    const lowerCasePayload = {
      ...upperCasePayload,
      tokenAddress: 'abcdefGh1234567890',
    };

    const [upperCaseEvent, lowerCaseEvent] = await Promise.all([
      normalizeActivity(upperCasePayload, Date.now()),
      normalizeActivity(lowerCasePayload, Date.now()),
    ]);

    expect(upperCaseEvent.tokenAddress).toBe('AbCdEfGh1234567890');
    expect(lowerCaseEvent.tokenAddress).toBe('abcdefGh1234567890');
    expect(upperCaseEvent.id).not.toBe(lowerCaseEvent.id);
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

  // The Fomo WebSocket is unverified (design spec section 3), so a frame may
  // carry arbitrarily long strings. Bounding them at the ingest boundary keeps
  // a hostile frame from persisting unbounded text into IndexedDB.
  it.each([
    ['tokenAddress', { tokenAddress: 'z'.repeat(129) }],
    ['userId', { userId: 'u'.repeat(129) }],
    ['userHandle', { userHandle: 'h'.repeat(129) }],
    ['ticker', { ticker: 't'.repeat(129) }],
    ['displayName', { displayName: 'd'.repeat(129) }],
    ['id', { id: 'i'.repeat(129) }],
  ])('rejects an over-long %s', async (_field, override) => {
    await expect(
      normalizeActivity({ ...buyFrame.payload, ...override }, 1_800_000_000_000),
    ).rejects.toThrowError('Invalid Fomo activity');
  });

  it('rejects an over-long thesis comment', async () => {
    await expect(
      normalizeActivity(
        { ...buyFrame.payload, type: 'thesis', comment: 'c'.repeat(4097) },
        1_800_000_000_000,
      ),
    ).rejects.toThrowError('Invalid Fomo activity');
  });

  it('accepts the longest supported Solana address', async () => {
    const event = await normalizeActivity(
      {
        ...buyFrame.payload,
        networkId: 101,
        tokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      },
      1_800_000_000_000,
    );

    expect(event.chain).toBe('solana');
    expect(event.tokenAddress).toBe(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
  });
});

describe('network catalog', () => {
  // Literal expected pairs: a changed mapping must fail a test, so
  // expectations are written down here rather than derived from the catalog.
  it('maps known network ids to their literal chains', () => {
    expect(mapNetworkId(1)).toBe('ethereum');
    expect(mapNetworkId(56)).toBe('bsc');
    expect(mapNetworkId(8453)).toBe('base');
    expect(mapNetworkId(101)).toBe('solana');
    expect(mapNetworkId(143)).toBe('monad');
    expect(mapNetworkId(10143)).toBe('monad');
  });

  it.each([0, -1, 10144, 999999, 56.5, Number.NaN])(
    'maps unknown networkId %p to unknown',
    (networkId) => {
      expect(mapNetworkId(networkId)).toBe('unknown');
    },
  );

  it('exposes the chain and verification status for every known network id', () => {
    expect(getNetworkMapping(1)).toEqual({
      chain: 'ethereum',
      status: 'established-in-codebase',
    });
    expect(getNetworkMapping(56)).toEqual({
      chain: 'bsc',
      status: 'established-in-codebase',
    });
    expect(getNetworkMapping(8453)).toEqual({
      chain: 'base',
      status: 'established-in-codebase',
    });
    expect(getNetworkMapping(101)).toEqual({
      chain: 'solana',
      status: 'provisional-unverified',
    });
    expect(getNetworkMapping(143)).toEqual({
      chain: 'monad',
      status: 'provisional-unverified',
    });
    expect(getNetworkMapping(10143)).toEqual({
      chain: 'monad',
      status: 'provisional-unverified',
    });
  });

  it('returns null for unmapped network ids', () => {
    expect(getNetworkMapping(999999)).toBeNull();
    expect(getNetworkMapping(0)).toBeNull();
  });

  it('keeps both monad ids provisional because the registries disagree on the mainnet id', () => {
    expect(getNetworkMapping(143)?.status).toBe('provisional-unverified');
    expect(getNetworkMapping(10143)?.status).toBe('provisional-unverified');
  });

  it('keeps mapNetworkId consistent with getNetworkMapping so status cannot drift', () => {
    for (const networkId of [1, 56, 8453, 101, 143, 10143]) {
      expect(mapNetworkId(networkId)).toBe(getNetworkMapping(networkId)?.chain);
    }
  });
});
