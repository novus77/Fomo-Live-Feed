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
 * EVERY entry is PROVISIONAL-UNVERIFIED: no real authenticated Fomo frame
 * could be captured in this environment, so no numeric networkId has been
 * observed on the wire. The IDs below are plausible placeholders only —
 * EIP-155 chain IDs where they exist (1, 56, 8453, 196), the conventional
 * Solana pseudo-ID (101), and a guessed internal ID for Robinhood (900001).
 * Robinhood's address family is UNCONFIRMED and deliberately never assumed
 * EVM or Solana. An entry may be promoted to 'verified-from-capture' only
 * after a real authenticated Fomo activity carrying that ID is captured,
 * redacted, and hashed (see the evidence doc's requirements-before-release).
 */
export const NETWORK_CATALOG: readonly NetworkCatalogEntry[] = [
  {
    networkId: 1,
    chain: 'ethereum',
    status: 'provisional-unverified',
    source:
      'EIP-155 chain ID 1 (Ethereum mainnet) per the chainid.network registry (chainid.network/chains.json); PROVISIONAL per docs/evidence/fomo-network-catalog.md — must be confirmed against a real authenticated Fomo frame before release.',
  },
  {
    networkId: 56,
    chain: 'bsc',
    status: 'provisional-unverified',
    source:
      'EIP-155 chain ID 56 (BNB Smart Chain) per the chainid.network registry (chainid.network/chains.json); PROVISIONAL per docs/evidence/fomo-network-catalog.md — must be confirmed against a real authenticated Fomo frame before release.',
  },
  {
    networkId: 8453,
    chain: 'base',
    status: 'provisional-unverified',
    source:
      'EIP-155 chain ID 8453 (Base) per the chainid.network registry (chainid.network/chains.json); PROVISIONAL per docs/evidence/fomo-network-catalog.md — must be confirmed against a real authenticated Fomo frame before release.',
  },
  {
    networkId: 101,
    chain: 'solana',
    status: 'provisional-unverified',
    source:
      'Solana mainnet-beta pseudo-ID 101 from the solana-labs/token-list chainId convention (raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json). Solana is not EVM and has no EIP-155 chain ID, so this is a conventional pseudo-ID used by multi-chain registries, not a verified Fomo value. PROVISIONAL per docs/evidence/fomo-network-catalog.md — must be confirmed against a real authenticated Fomo frame before release.',
  },
  {
    networkId: 196,
    chain: 'x-layer',
    status: 'provisional-unverified',
    source:
      'EIP-155 chain ID 196 (X Layer, OKX) per the chainid.network registry (chainid.network/chains.json); address family assumed EVM-compatible but UNVERIFIED. PROVISIONAL per docs/evidence/fomo-network-catalog.md — must be confirmed against a real authenticated Fomo frame before release.',
  },
  {
    networkId: 900001,
    chain: 'robinhood',
    status: 'provisional-unverified',
    source:
      'Guessed internal Fomo ID for Robinhood (not an EIP-155 chain ID); address family UNCONFIRMED and deliberately never assumed EVM or Solana (docs/evidence/fomo-network-catalog.md). PROVISIONAL — must be confirmed against a real authenticated Fomo frame before release.',
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
 * ONLY entries documented in docs/evidence/fomo-network-catalog.md with
 * status 'verified-from-capture' may resolve to a concrete chain. Because no
 * entry is verified yet, mapNetworkId returns 'unknown' for EVERY catalogued
 * ID today — the production adapter stays honest about the provisional
 * catalog and no UI badge may claim a chain (plan Task 3 step 4). Callers
 * that need the provisional chain or the verification status should use
 * getNetworkMapping instead.
 */
export function mapNetworkId(networkId: number): ChainKey {
  const mapping = getNetworkMapping(networkId);

  if (mapping === null || mapping.status !== 'verified-from-capture') {
    return 'unknown';
  }

  return mapping.chain;
}
