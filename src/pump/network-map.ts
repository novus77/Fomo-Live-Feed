import type { ChainKey } from '../domain/activity';

/** Confirmed from the authenticated Pump Following trade capture. */
const PUMP_CHAIN_IDS = new Map<number, ChainKey>([
  [1399811149, 'solana'],
]);

export function mapPumpChainId(chainId: number): ChainKey {
  return PUMP_CHAIN_IDS.get(chainId) ?? 'unknown';
}
