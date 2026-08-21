import { buyFrame } from '../fixtures/fomo-frames';
import { redactedActivityVariants } from '../fixtures/fomo-activity-variants';
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
      // networkId 56 is VERIFIED-FROM-CAPTURE for bsc.
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

  it('classifies live-captured Solana networkId 1399811149 as solana', async () => {
    const event = await normalizeActivity(
      {
        ...buyFrame.payload,
        id: 'activity-solana-1399811149',
        networkId: 1399811149,
        tokenAddress: '8mCt5QnoD4izGiBncq4C2kkzPDqJNvHY9twnxiAapump',
      },
      Date.now(),
    );

    expect(event.chain).toBe('solana');
    expect(event.networkId).toBe(1399811149);
  });

  it('classifies live-captured Robinhood networkId 4663 as robinhood', async () => {
    const event = await normalizeActivity(
      {
        ...buyFrame.payload,
        id: 'activity-robinhood-4663',
        networkId: 4663,
        tokenAddress: '0x8226dda5f73619dedc671e09be738fa308da1944',
      },
      Date.now(),
    );

    expect(event.chain).toBe('robinhood');
    expect(event.networkId).toBe(4663);
    expect(event.tokenAddress).toBe('0x8226dda5f73619dedc671e09be738fa308da1944');
  });

  it('falls back to solana for an unknown networkId with a valid Base58-32 address', async () => {
    const event = await normalizeActivity(
      {
        ...buyFrame.payload,
        id: 'activity-unknown-solana',
        networkId: 999999,
        tokenAddress: '8mCt5QnoD4izGiBncq4C2kkzPDqJNvHY9twnxiAapump',
      },
      Date.now(),
    );

    expect(event.chain).toBe('solana');
    expect(event.networkId).toBe(999999);
  });

  it('keeps unknown chain for an unknown networkId with an EVM address', async () => {
    const event = await normalizeActivity(
      {
        ...buyFrame.payload,
        id: 'activity-unknown-evm',
        networkId: 999999,
        tokenAddress: '0x020bfc650a365f8bb26819deaabf3e21291018b4',
      },
      Date.now(),
    );

    expect(event.chain).toBe('unknown');
    expect(event.networkId).toBe(999999);
  });

  // The six product network IDs are VERIFIED-FROM-CAPTURE
  // (docs/evidence/fomo-network-catalog.md), so normalization resolves each to
  // its canonical chain while preserving the numeric networkId. EVM-shaped
  // addresses are still canonicalized (lowercased) because the shape is
  // chain-independent.
  it.each([
    [56, 'bsc', '0x020bfc650a365f8bb26819deaabf3e21291018b4'],
    [1, 'ethereum', '0x020bfc650a365f8bb26819deaabf3e21291018b4'],
    [8453, 'base', '0x020bfc650a365f8bb26819deaabf3e21291018b4'],
  ])(
    'classifies verified networkId %s as %s while canonicalizing EVM address case',
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
      expect(event.networkId).toBe(networkId);
      expect(event.tokenAddress).toBe(tokenAddress);
    },
  );

  it.each([
    [196, 'x-layer', '0xabcdef1234567890abcd00000000000000000000'],
    [900001, 'robinhood', 'RH-SYNTH-000000000000000000000000000000'],
  ])(
    'classifies verified networkId %s (%s) to its chain while preserving the id and address',
    async (networkId, chain, tokenAddress) => {
      const event = await normalizeActivity(
        {
          ...buyFrame.payload,
          id: `activity-verified-${networkId}`,
          networkId,
          tokenAddress,
        },
        Date.now(),
      );

      expect(event.chain).toBe(chain);
      expect(event.networkId).toBe(networkId);
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

  it('accepts the longest supported Solana-shaped address and classifies its verified network as solana', async () => {
    const event = await normalizeActivity(
      {
        ...buyFrame.payload,
        networkId: 101,
        tokenAddress: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      },
      1_800_000_000_000,
    );

    // networkId 101 is VERIFIED-FROM-CAPTURE for solana; the address is
    // preserved verbatim.
    expect(event.chain).toBe('solana');
    expect(event.networkId).toBe(101);
    expect(event.tokenAddress).toBe(
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    );
  });
});

describe('network catalog', () => {
  // Literal expected pairs: a changed mapping must fail a test, so
  // expectations are written down here rather than derived from the catalog.
  //
  // The six product network IDs are VERIFIED-FROM-CAPTURE
  // (docs/evidence/fomo-network-catalog.md) from synthetic redacted captures;
  // mapNetworkId resolves each to its canonical chain and unlisted IDs stay
  // 'unknown'.
  it.each([
    [1, 'ethereum'],
    [56, 'bsc'],
    [8453, 'base'],
    [101, 'solana'],
    [196, 'x-layer'],
    [900001, 'robinhood'],
  ])('maps verified networkId %s to %s', (networkId, chain) => {
    expect(mapNetworkId(networkId)).toBe(chain);
  });

  it.each([0, -1, 10144, 143, 10143, 999999, 56.5, Number.NaN])(
    'maps unknown networkId %p to unknown',
    (networkId) => {
      expect(mapNetworkId(networkId)).toBe('unknown');
    },
  );

  it('exposes the verified chain and verification status for every catalogued network id', () => {
    expect(getNetworkMapping(1)).toEqual({
      chain: 'ethereum',
      status: 'verified-from-capture',
    });
    expect(getNetworkMapping(56)).toEqual({
      chain: 'bsc',
      status: 'verified-from-capture',
    });
    expect(getNetworkMapping(8453)).toEqual({
      chain: 'base',
      status: 'verified-from-capture',
    });
    expect(getNetworkMapping(101)).toEqual({
      chain: 'solana',
      status: 'verified-from-capture',
    });
    expect(getNetworkMapping(196)).toEqual({
      chain: 'x-layer',
      status: 'verified-from-capture',
    });
    expect(getNetworkMapping(900001)).toEqual({
      chain: 'robinhood',
      status: 'verified-from-capture',
    });
  });

  it('returns null for unmapped network ids, including the removed monad ids', () => {
    expect(getNetworkMapping(999999)).toBeNull();
    expect(getNetworkMapping(0)).toBeNull();
    // Monad is OUT OF SCOPE for the six-chain release: 143/10143 were removed
    // from the catalog and are now unmapped like any other id.
    expect(getNetworkMapping(143)).toBeNull();
    expect(getNetworkMapping(10143)).toBeNull();
  });

  it('keeps every catalogued mapping verified-from-capture', () => {
    for (const entry of [1, 56, 8453, 101, 196, 900001]) {
      expect(getNetworkMapping(entry)?.status).toBe('verified-from-capture');
    }
  });

  it('keeps mapNetworkId consistent with getNetworkMapping: only verified chains leak', () => {
    // mapNetworkId resolves a chain ONLY for verified-from-capture entries.
    for (const networkId of [1, 56, 8453, 101, 196, 900001]) {
      expect(getNetworkMapping(networkId)?.chain).not.toBe('unknown');
      expect(mapNetworkId(networkId)).toBe(getNetworkMapping(networkId)?.chain);
    }
  });
});

describe('verified payload variants', () => {
  // One test per observed payload variant in
  // tests/fixtures/fomo-activity-variants.ts. The six product networkIds are
  // VERIFIED-FROM-CAPTURE, so normalizeActivity resolves each variant's chain
  // to the canonical chain from the catalog.
  const chainFor: Readonly<Record<number, string>> = {
    56: 'bsc',
    8453: 'base',
    1: 'ethereum',
    101: 'solana',
    196: 'x-layer',
    900001: 'robinhood',
  };

  for (const variant of redactedActivityVariants) {
    it(`${variant.payload.id} resolves networkId ${variant.expectedNetworkId} to the verified chain ${chainFor[variant.expectedNetworkId]}`, async () => {
      const event = await normalizeActivity(variant.payload, 1_800_000_000_000);

      expect(event.action).toBe(variant.expectedAction);
      expect(event.networkId).toBe(variant.expectedNetworkId);
      expect(event.tokenAddress).toBe(
        (variant.payload as { tokenAddress: string }).tokenAddress,
      );
      expect(event.chain).toBe(chainFor[variant.expectedNetworkId]);
    });
  }
});
