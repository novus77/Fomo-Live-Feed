import type { ChainKey } from '../domain/activity';
import { validateContractAddress } from './contract-address';

const PUMP_ORIGIN = 'https://pump.fun';
const PROFILE_IDENTIFIER = /^[a-zA-Z0-9_-]{1,256}$/;

export function buildPumpProfileUrl(identifier: string): URL | null {
  if (!PROFILE_IDENTIFIER.test(identifier)) return null;

  const url = new URL(`/profile/${encodeURIComponent(identifier)}`, PUMP_ORIGIN);
  return url.origin === PUMP_ORIGIN ? url : null;
}

/** Builds the official Pump coin route for a validated Solana mint. */
export function buildPumpTokenUrl(chain: ChainKey, address: string): URL | null {
  const validation = validateContractAddress(chain, address);
  if (!validation.ok || validation.chain !== 'solana') return null;

  const url = new URL(`/coin/${encodeURIComponent(validation.canonical)}`, PUMP_ORIGIN);
  return url.origin === PUMP_ORIGIN ? url : null;
}
