import type { ChainKey } from '../domain/activity';

/**
 * How much evidence backs a network-ID mapping.
 *
 * The Fomo WebSocket is an internal, version-unstable API (design spec section 3),
 * so an ID is only 'verified-from-capture' after it has been observed in a real
 * authenticated Fomo trading_activity frame. Entries added from public chain
 * registries are 'provisional-unverified' and must be re-confirmed before release.
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

export const NETWORK_CATALOG: readonly NetworkCatalogEntry[] = [
  {
    networkId: 1,
    chain: 'ethereum',
    status: 'established-in-codebase',
    source:
      'Pre-existing mapping in this repo before the catalog refactor; no in-repo capture artifact — re-confirm against a real authenticated Fomo frame before release.',
  },
  {
    networkId: 56,
    chain: 'bsc',
    status: 'established-in-codebase',
    source:
      'Pre-existing mapping in this repo before the catalog refactor; no in-repo capture artifact — re-confirm against a real authenticated Fomo frame before release.',
  },
  {
    networkId: 8453,
    chain: 'base',
    status: 'established-in-codebase',
    source:
      'Pre-existing mapping in this repo before the catalog refactor; no in-repo capture artifact — re-confirm against a real authenticated Fomo frame before release.',
  },
  {
    networkId: 101,
    chain: 'solana',
    status: 'provisional-unverified',
    source:
      'Solana mainnet-beta pseudo-ID 101 from the solana-labs/token-list chainId convention (raw.githubusercontent.com/solana-labs/token-list/main/src/tokens/solana.tokenlist.json). Solana is not EVM and has no EIP-155 chain ID, so this is a conventional pseudo-ID used by multi-chain registries, not a verified Fomo value. MUST be confirmed against a real authenticated Fomo frame before release.',
  },
  {
    networkId: 143,
    chain: 'monad',
    status: 'provisional-unverified',
    source:
      'Monad mainnet EIP-155 chain ID 143 per the chainid.network registry (chainid.network/chains.json) and the GoldRush changelog "Monad Mainnet Now Supported" (goldrush.dev/docs/changelog/20251124-monad-mainnet-now-supported). NOTE: chainid.network and chainlist.org DISAGREE about whether 143 or 10143 is Monad mainnet, so both IDs stay provisional until a real authenticated Fomo frame confirms which one Fomo emits. MUST be confirmed before release.',
  },
  {
    networkId: 10143,
    chain: 'monad',
    status: 'provisional-unverified',
    source:
      'Monad chain ID 10143 per the official Monad docs (docs.monad.xyz/developer-essentials/testnets). NOTE: chainid.network and chainlist.org DISAGREE about whether 143 or 10143 is Monad mainnet, so both IDs stay provisional until a real authenticated Fomo frame confirms which one Fomo emits. Provisionally mapped to the same ChainKey because the canonical model has no testnet variant. MUST be confirmed before release.',
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
 * 'unknown' for IDs outside the catalog. Callers that need to know whether
 * the mapping is verified should use getNetworkMapping instead.
 */
export function mapNetworkId(networkId: number): ChainKey {
  return getNetworkMapping(networkId)?.chain ?? 'unknown';
}
