import type { ChainKey } from '../domain/activity';

const NETWORK_ID_TO_CHAIN: Readonly<Record<string, ChainKey>> = {
  '1': 'ethereum',
  '56': 'bsc',
  '8453': 'base',
};

export function mapNetworkId(networkId: number | string): ChainKey {
  return NETWORK_ID_TO_CHAIN[String(networkId)] ?? 'unknown';
}
