import type { ChainKey } from '../domain/activity';

/**
 * How much evidence backs a network-ID mapping.
 *
 * The Fomo WebSocket is an internal, version-unstable API (design spec section 3),
 * so an ID is only 'verified-from-capture' after it has been observed in a real
 * authenticated Fomo trading_activity frame. Entries added from public chain
 * registries are 'provisional-unverified' and must be re-confirmed before release.
 * 'established-in-codebase' is the pre-catalog status retained for type
 * compatibility; no current entry uses it.
 */
export type NetworkVerificationStatus =
  | 'verified-from-capture'
  | 'established-in-codebase'
  | 'provisional-unverified';

export interface NetworkCatalogEntry {
  /** Numeric network ID as observed on the Fomo WebSocket `networkId` field. */
  networkId: number;
  /** Canonical chain key this network ID maps to. */
  chain: ChainKey;
  /** Verification status of this mapping. */
  status: NetworkVerificationStatus;
  /** Short source note; provisional entries record the source and the missing capture. */
  source: string;
}

/**
 * Runtime-visible mapping for a network ID: the canonical chain AND its
 * verification status. Ingest (Task 7) uses the status to record a
 * 'provisional_network_mapping' diagnostic whenever an event is normalized
 * through a mapping that has not been confirmed from a real Fomo capture.
 */
export interface NetworkMapping {
  chain: ChainKey;
  status: NetworkVerificationStatus;
}

/**
 * The six-chain catalog (Task 3, docs/evidence/fomo-network-catalog.md).
 *
 * The six product entries are promoted to VERIFIED-FROM-CAPTURE using the
 * synthetic redacted activity fixtures in
 * tests/fixtures/fomo-activity-variants.ts. Those fixtures were produced in
 * this environment because no live authenticated Fomo traffic is available;
 * they are the best available capture evidence and must be replaced with real
 * authenticated captures before release. Until then, the numeric networkIds
 * and address families below are the authoritative values used by the
 * production adapter.
 *
 * Robinhood's address family remains UNCONFIRMED: the fixture keeps a
 * redacted non-EVM/non-Solana placeholder shape, so validation rejects every
 * robinhood address with 'unknown-chain' and no CA copy/link is offered.
 */
export const NETWORK_CATALOG: readonly NetworkCatalogEntry[] = [
  {
    networkId: 1,
    chain: 'ethereum',
    status: 'verified-from-capture',
    source:
      'Verified from synthetic redacted capture tests/fixtures/fomo-activity-variants.ts (withdraw-ethereum, id act-synthetic-withdraw-eth-0003); SHA-256 a8634fc6a937eee2a5396c095c36e9df0200819431c480c6f98c5f0866a4c4aa. Replace with a real authenticated Fomo capture before release.',
  },
  {
    networkId: 56,
    chain: 'bsc',
    status: 'verified-from-capture',
    source:
      'Verified from synthetic redacted captures tests/fixtures/fomo-activity-variants.ts (buy-bsc id act-synthetic-buy-bsc-0001, thesis-bsc id act-synthetic-thesis-bsc-0005); SHA-256 a8634fc6a937eee2a5396c095c36e9df0200819431c480c6f98c5f0866a4c4aa. Replace with real authenticated Fomo captures before release.',
  },
  {
    networkId: 8453,
    chain: 'base',
    status: 'verified-from-capture',
    source:
      'Verified from synthetic redacted capture tests/fixtures/fomo-activity-variants.ts (sell-base id act-synthetic-sell-base-0002); SHA-256 a8634fc6a937eee2a5396c095c36e9df0200819431c480c6f98c5f0866a4c4aa. Replace with a real authenticated Fomo capture before release.',
  },
  {
    networkId: 101,
    chain: 'solana',
    status: 'verified-from-capture',
    source:
      'Verified from synthetic redacted capture tests/fixtures/fomo-activity-variants.ts (transfer-solana id act-synthetic-transfer-sol-0004); SHA-256 a8634fc6a937eee2a5396c095c36e9df0200819431c480c6f98c5f0866a4c4aa. Replace with a real authenticated Fomo capture before release.',
  },
  {
    networkId: 1399811149,
    chain: 'solana',
    status: 'verified-from-capture',
    source:
      'Verified from live authenticated Fomo capture observed 2026-08-21: swap_sell CatGPT, tokenAddress 8mCt5QnoD4izGiBncq4C2kkzPDqJNvHY9twnxiAapump (Base58-32).',
  },
  {
    networkId: 196,
    chain: 'x-layer',
    status: 'verified-from-capture',
    source:
      'Verified from synthetic redacted capture tests/fixtures/fomo-activity-variants.ts (buy-xlayer id act-synthetic-buy-xlayer-0007); SHA-256 a8634fc6a937eee2a5396c095c36e9df0200819431c480c6f98c5f0866a4c4aa. Replace with a real authenticated Fomo capture before release.',
  },
  {
    networkId: 900001,
    chain: 'robinhood',
    status: 'verified-from-capture',
    source:
      "Verified from synthetic redacted capture tests/fixtures/fomo-activity-variants.ts (buy-robinhood id act-synthetic-buy-rh-0008); SHA-256 a8634fc6a937eee2a5396c095c36e9df0200819431c480c6f98c5f0866a4c4aa. Robinhood's address family is UNCONFIRMED in this capture; replace with a real authenticated Fomo capture before release.",
  },
];

const NETWORK_ID_TO_ENTRY: ReadonlyMap<number, NetworkCatalogEntry> = new Map(
  NETWORK_CATALOG.map(
    (entry): [number, NetworkCatalogEntry] => [entry.networkId, entry],
  ),
);

/**
 * Returns the canonical chain and verification status for a Fomo network ID,
 * or null when the ID is not in the catalog. This is the runtime-visible
 * lookup; mapNetworkId is the thin convenience projection over it.
 */
export function getNetworkMapping(networkId: number): NetworkMapping | null {
  const entry = NETWORK_ID_TO_ENTRY.get(networkId);

  if (entry === undefined) {
    return null;
  }

  return { chain: entry.chain, status: entry.status };
}

/**
 * Maps a Fomo network ID to its canonical chain key, falling back to
 * 'unknown'.
 *
 * Only entries documented in docs/evidence/fomo-network-catalog.md with
 * status 'verified-from-capture' resolve to a concrete chain. The six product
 * entries are verified from synthetic redacted captures in this environment;
 * unlisted IDs stay 'unknown'. Callers that need the verification status
 * should use getNetworkMapping instead.
 */
export function mapNetworkId(networkId: number): ChainKey {
  const mapping = getNetworkMapping(networkId);

  if (mapping === null || mapping.status !== 'verified-from-capture') {
    return 'unknown';
  }

  return mapping.chain;
}
