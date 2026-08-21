import type { ChainKey } from '../domain/activity';

/**
 * Chain-aware contract address validation.
 *
 * EVM chains accept exactly `0x` (or `0X`) followed by 40 hexadecimal
 * characters, matching the existing EVM pattern in src/fomo/normalize.ts.
 * Comparisons are checksum-insensitive: mixed-case addresses are accepted and
 * every successful EVM validation exposes a canonical lowercase form.
 *
 * Solana addresses are validated by decoding the Base58 string (the
 * Bitcoin/IPFS alphabet, which excludes `0`, `O`, `I`, and `l`) and
 * requiring the decoded byte length to be exactly 32. Character length alone
 * is never used, because 43-44 characters can decode to 31-33 bytes.
 *
 * Decoding is O(n^2) on the input length (a BigInt accumulator per character),
 * so every branch applies a cheap character-length pre-filter BEFORE any
 * decode or pattern work. A 32-byte Base58 value is at most 44 characters, so
 * MAX_BASE58_ADDRESS_LENGTH of 64 is generous; anything longer cannot decode
 * to 32 bytes and is rejected immediately. This guards every toast link
 * against a hostile frame sending an unbounded `tokenAddress`.
 *
 * Robinhood (900001) has an UNCONFIRMED address family (docs/evidence/fomo-
 * network-catalog.md): it is deliberately never assumed EVM or Solana, so
 * validation always rejects it with the 'unknown-chain' verdict and a
 * robinhood address can never be copied or linked. The `unknown` chain (and
 * any provisional chain without a confirmed address family) is likewise
 * always rejected. There is deliberately no "probably EVM" fallback.
 */

const EVM_CHAINS: ReadonlySet<string> = new Set([
  'ethereum',
  'bsc',
  'base',
  'x-layer',
]);

/**
 * Canonical EVM address regex: exactly `0x` (or `0X`) plus 40 hexadecimal
 * characters. This is the single source of truth for EVM shape checks, imported
 * by src/fomo/normalize.ts so the two paths cannot drift apart.
 */
export const EVM_ADDRESS_PATTERN = /^0[xX][a-fA-F0-9]{40}$/;

/** A 32-byte Base58 value is at most 44 characters; 64 is a generous cap. */
export const MAX_BASE58_ADDRESS_LENGTH = 64;

/** Exact EVM form is 0x plus 40 hex characters, i.e. 42 characters. */
export const MAX_EVM_ADDRESS_LENGTH = 42;

const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const BASE58_INDEX: Readonly<Record<string, number>> = Object.fromEntries(
  [...BASE58_ALPHABET].map((char, index) => [char, index]),
);

/** Decodes a Base58 string to bytes, or null when it contains an invalid character. */
function decodeBase58(value: string): Uint8Array | null {
  if (value.length === 0) {
    return new Uint8Array(0);
  }

  let accumulator = 0n;

  for (const char of value) {
    const digit = BASE58_INDEX[char];

    if (digit === undefined) {
      return null;
    }

    accumulator = accumulator * 58n + BigInt(digit);
  }

  const bytes: number[] = [];
  let remainder = accumulator;

  while (remainder > 0n) {
    bytes.unshift(Number(remainder & 0xffn));
    remainder >>= 8n;
  }

  // Leading '1' characters encode leading zero bytes.
  let leadingZeros = 0;

  for (const char of value) {
    if (char !== '1') {
      break;
    }

    leadingZeros += 1;
  }

  const decoded = new Uint8Array(leadingZeros + bytes.length);
  decoded.set(bytes, leadingZeros);

  return decoded;
}

/** An address that has already passed chain-specific validation. */
export interface ValidatedContractAddress {
  chain: ChainKey;
  canonical: string;
}

export type ContractAddressValidation =
  | ({ ok: true } & ValidatedContractAddress)
  | { ok: false; reason: string };

export function validateContractAddress(
  chain: ChainKey,
  address: string,
): ContractAddressValidation {
  if (typeof address !== 'string') {
    return { ok: false, reason: 'address must be a string' };
  }

  if (EVM_CHAINS.has(chain)) {
    if (address.length > MAX_EVM_ADDRESS_LENGTH) {
      return {
        ok: false,
        reason: `EVM address must be at most ${MAX_EVM_ADDRESS_LENGTH} characters`,
      };
    }

    if (!EVM_ADDRESS_PATTERN.test(address)) {
      return {
        ok: false,
        reason: 'EVM address must start with 0x and contain exactly 40 hexadecimal characters',
      };
    }

    return {
      ok: true,
      chain,
      canonical: address.toLowerCase(),
    };
  }

  if (chain === 'solana') {
    if (address.length > MAX_BASE58_ADDRESS_LENGTH) {
      return {
        ok: false,
        reason: `Solana address must be at most ${MAX_BASE58_ADDRESS_LENGTH} characters`,
      };
    }

    const decoded = decodeBase58(address);

    if (decoded === null) {
      return {
        ok: false,
        reason: 'Solana address contains characters outside the Base58 alphabet',
      };
    }

    if (decoded.length !== 32) {
      return {
        ok: false,
        reason: 'Solana address must decode to exactly 32 bytes',
      };
    }

    return {
      ok: true,
      chain,
      canonical: address,
    };
  }

  if (chain === 'robinhood') {
    // UNCONFIRMED address family (docs/evidence/fomo-network-catalog.md):
    // never assumed EVM or Solana, so every robinhood address is rejected and
    // the 'unknown-chain' verdict keeps it non-copyable / non-linkable.
    return {
      ok: false,
      reason: 'unknown-chain: robinhood address family is unconfirmed',
    };
  }

  if (chain === 'unknown') {
    return {
      ok: false,
      reason: 'unknown-chain',
    };
  }

  return {
    ok: false,
    reason: `unsupported chain: ${chain}`,
  };
}

/**
 * Infers a chain key from the address shape alone. This is a FALLBACK for
 * network IDs the catalog does not know: it never guesses EVM (multiple chains
 * share the same address family), but Solana's Base58-32 shape is unique
 * enough to identify confidently. Returns null when the shape is ambiguous.
 */
export function inferChainFromTokenAddress(address: string): ChainKey | null {
  if (typeof address !== 'string') {
    return null;
  }

  if (address.length > MAX_BASE58_ADDRESS_LENGTH) {
    return null;
  }

  const decoded = decodeBase58(address);

  if (decoded !== null && decoded.length === 32) {
    return 'solana';
  }

  return null;
}

export interface ShortenOptions {
  head?: number;
  tail?: number;
}

const DEFAULT_SHORTEN_HEAD = 6;
const DEFAULT_SHORTEN_TAIL = 4;
const ELLIPSIS = '…';

/**
 * Shortens an already-validated address for display (for example
 * `0x1234…abcd`). The input type only exists as the success branch of
 * validateContractAddress, and the canonical value is re-validated as a
 * defensive guard, so unvalidated or hostile strings cannot be shortened.
 */
export function shortenContractAddress(
  address: ValidatedContractAddress,
  options?: ShortenOptions,
): string {
  const head = options?.head ?? DEFAULT_SHORTEN_HEAD;
  const tail = options?.tail ?? DEFAULT_SHORTEN_TAIL;

  if (!Number.isInteger(head) || head <= 0) {
    throw new TypeError('head must be a positive integer');
  }

  if (!Number.isInteger(tail) || tail <= 0) {
    throw new TypeError('tail must be a positive integer');
  }

  const validation = validateContractAddress(address.chain, address.canonical);

  if (!validation.ok) {
    throw new TypeError(
      'shortenContractAddress requires an address produced by validateContractAddress',
    );
  }

  if (address.canonical.length <= head + tail) {
    return address.canonical;
  }

  return `${address.canonical.slice(0, head)}${ELLIPSIS}${address.canonical.slice(-tail)}`;
}
