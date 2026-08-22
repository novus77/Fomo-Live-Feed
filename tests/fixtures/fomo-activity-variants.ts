/**
 * SYNTHETIC redacted activity payload variants (recovery plan Task 1).
 *
 * No live authenticated Fomo traffic is available in this environment, so
 * these records are hand-authored reconstructions of the payload shape
 * documented in src/fomo/raw-schema.ts and
 * docs/evidence/fomo-activity-contract.md. They preserve field names, nesting,
 * and types; EVERY value is synthetic — no real identity, address, amount,
 * timestamp, URL, or opinion text appears here. Each entry's payload `id`
 * encodes the variant it models (for example 'act-synthetic-buy-bsc-0001').
 *
 * Addresses are synthetic but structurally valid for their chain family:
 *   - EVM variants use a full `0x` + 40 hexadecimal characters.
 *   - Solana uses a synthetic Base58 string that decodes to exactly 32 bytes.
 *   - Robinhood keeps a redacted non-EVM/non-Solana placeholder shape.
 * Network IDs match the captured/verified catalog in
 * docs/evidence/fomo-network-catalog.md.
 *
 * Every entry satisfies the compile-time container used by the recovery plan:
 * one complete redacted record per observed payload variant. The array must
 * stay non-empty and every entry must carry a numeric expectedNetworkId.
 */
export const redactedActivityVariants = [
  {
    expectedAction: 'buy',
    expectedNetworkId: 56,
    payload: {
      id: 'act-synthetic-buy-bsc-0001',
      tradeId: 'trade-synthetic-0001',
      type: 'swap_buy',
      userId: 'user-synthetic-0001',
      userHandle: 'synthetic-trader-01',
      ticker: 'SPRK',
      tokenAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      networkId: 56,
      createdAt: '2026-08-20T08:15:30.000Z',
      displayName: 'Synthetic Trader One',
      profilePictureLink: 'https://example.com/avatar-01.png',
      tokenImageUrl: 'https://example.com/token-spark.png',
      usdAmount: 1250.5,
      marketCap: 4200000,
      price: 0.42,
    },
  },
  {
    expectedAction: 'sell',
    expectedNetworkId: 8453,
    payload: {
      id: 'act-synthetic-sell-base-0002',
      tradeId: 'trade-synthetic-0002',
      type: 'swap_sell',
      userId: 'user-synthetic-0002',
      userHandle: 'synthetic-trader-02',
      ticker: 'NOVA',
      tokenAddress: '0xba5eba5eba5eba5eba5eba5eba5eba5eba5eba5e',
      networkId: 8453,
      createdAt: '2026-08-20T08:16:00.000Z',
      displayName: 'Synthetic Trader Two',
      usdAmount: 840.25,
      marketCap: 1250000,
      price: 0.083,
    },
  },
  {
    expectedAction: 'withdraw',
    expectedNetworkId: 1,
    payload: {
      id: 'act-synthetic-withdraw-eth-0003',
      type: 'swap_withdraw',
      userId: 'user-synthetic-0003',
      userHandle: 'synthetic-trader-03',
      ticker: 'VOID',
      tokenAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
      networkId: 1,
      createdAt: '2026-08-20T08:16:30.000Z',
      usdAmount: 2500,
    },
  },
  {
    expectedAction: 'transfer',
    expectedNetworkId: 101,
    payload: {
      id: 'act-synthetic-transfer-sol-0004',
      tradeId: 'trade-synthetic-0004',
      type: 'transfer_out',
      userId: 'user-synthetic-0004',
      userHandle: 'synthetic-trader-04',
      ticker: 'PULSE',
      tokenAddress: '8mmHEQ3y51XUpfBSdQcDGHQfnTShYonSdezUPL5Va18G',
      networkId: 101,
      createdAt: '2026-08-20T08:17:00.000Z',
      displayName: 'Synthetic Trader Four',
      tokenImageUrl: 'https://example.com/token-pulse.png',
      usdAmount: 375.75,
    },
  },
  {
    expectedAction: 'thesis',
    expectedNetworkId: 56,
    payload: {
      id: 'act-synthetic-thesis-bsc-0005',
      type: 'thesis',
      userId: 'user-synthetic-0005',
      userHandle: 'synthetic-trader-05',
      ticker: 'HALO',
      tokenAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb0001',
      networkId: 56,
      createdAt: '2026-08-20T08:17:30.000Z',
      comment: {
        comment: 'SYNTHETIC PLACEHOLDER OPINION: volume profile looks constructive.',
      },
    },
  },
  {
    expectedAction: 'thesis',
    expectedNetworkId: 1,
    payload: {
      id: 'act-synthetic-thesis-eth-0006',
      type: 'thesis',
      userId: 'user-synthetic-0006',
      userHandle: 'synthetic-trader-06',
      ticker: 'RHO',
      tokenAddress: '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee0001',
      networkId: 1,
      createdAt: '2026-08-20T08:18:00.000Z',
      comment: 'SYNTHETIC PLACEHOLDER OPINION: accumulation pattern observed.',
    },
  },
  {
    expectedAction: 'buy',
    expectedNetworkId: 196,
    payload: {
      id: 'act-synthetic-buy-xlayer-0007',
      tradeId: 'trade-synthetic-0007',
      type: 'swap_buy',
      userId: 'user-synthetic-0007',
      userHandle: 'synthetic-trader-07',
      ticker: 'XLN',
      tokenAddress: '0x1961961961961961961961961961961961961961',
      networkId: 196,
      createdAt: '2026-08-20T08:18:30.000Z',
      displayName: 'Synthetic Trader Seven',
      usdAmount: 1100,
      marketCap: 900000,
      price: 0.011,
    },
  },
  {
    expectedAction: 'buy',
    expectedNetworkId: 900001,
    payload: {
      id: 'act-synthetic-buy-rh-0008',
      tradeId: 'trade-synthetic-0008',
      type: 'swap_buy',
      userId: 'user-synthetic-0008',
      userHandle: 'synthetic-trader-08',
      ticker: 'RHT',
      tokenAddress: 'RH-SYNTH-000000000000000000000000000000',
      networkId: 900001,
      createdAt: '2026-08-20T08:19:00.000Z',
      usdAmount: 5200,
      marketCap: 30000000,
      price: 3.2,
    },
  },
] as const satisfies readonly {
  expectedAction: 'buy' | 'sell' | 'withdraw' | 'transfer' | 'thesis';
  expectedNetworkId: number;
  payload: Readonly<Record<string, unknown>>;
}[];
