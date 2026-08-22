import type { ChainKey } from '../domain/activity';
import { validateContractAddress } from './contract-address';

/**
 * Verified navigation targets for the Fomo site.
 *
 * NOTE ON PATHS: the `/token/` and `/user/` path shapes below are
 * PROVISIONAL. The production Fomo URL layout has not been verified against
 * the live site in the design spec, so the paths are reasonable choices that
 * may need to be corrected in this one place. The security-relevant
 * invariants are the fixed HTTPS origin (`https://fomo.family`) and the
 * chain/address/handle validation that gates URL construction: callers can
 * never supply an origin or base, and no input can make these builders
 * produce a `javascript:`, `data:`, protocol-relative, or foreign URL.
 */

const FOMO_ORIGIN = 'https://fomo.family';

const TOKEN_PATH = '/token/';
const PROFILE_PATH = '/user/';

/** Conservative handle allowlist: alphanumerics and underscores only. */
const HANDLE_PATTERN = /^[a-zA-Z0-9_]+$/;

export const MAX_FOMO_HANDLE_LENGTH = 30;

export type HandleValidation =
  | { ok: true; handle: string }
  | { ok: false; reason: string };

export function validateFomoHandle(handle: string): HandleValidation {
  if (typeof handle !== 'string') {
    return { ok: false, reason: 'handle must be a string' };
  }

  if (handle.length === 0) {
    return { ok: false, reason: 'handle must not be empty' };
  }

  if (handle.length > MAX_FOMO_HANDLE_LENGTH) {
    return {
      ok: false,
      reason: `handle must be at most ${MAX_FOMO_HANDLE_LENGTH} characters`,
    };
  }

  if (!HANDLE_PATTERN.test(handle)) {
    return {
      ok: false,
      reason: 'handle must match the conservative allowlist [a-zA-Z0-9_]',
    };
  }

  return { ok: true, handle };
}

/**
 * Parses a path against the fixed origin and asserts the result stayed on it.
 * Unreachable via the public API for the validated path segments below, but
 * guards the origin invariant if a future path change regresses.
 */
function fomoUrl(path: string): URL {
  const url = new URL(path, FOMO_ORIGIN);

  if (url.origin !== FOMO_ORIGIN) {
    throw new Error('fomo URL builder escaped the fixed origin');
  }

  return url;
}

/**
 * Builds a token page URL, returning null unless the address passes
 * chain-specific validation. The canonical (lowercased EVM or verbatim
 * Base58) address is used in the path, so only safe alphabets reach the URL.
 */
export function buildFomoTokenUrl(chain: ChainKey, address: string): URL | null {
  const validation = validateContractAddress(chain, address);

  if (!validation.ok) {
    return null;
  }

  return fomoUrl(`${TOKEN_PATH}${validation.chain}/${validation.canonical}`);
}

/**
 * Builds a trader profile URL, returning null unless the handle passes the
 * conservative allowlist. The handle is URL-encoded even though every
 * allowlisted character is URL-safe, as defense-in-depth against future
 * allowlist widening.
 */
export function buildFomoProfileUrl(handle: string): URL | null {
  const validation = validateFomoHandle(handle);

  if (!validation.ok) {
    return null;
  }

  return fomoUrl(`${PROFILE_PATH}${encodeURIComponent(validation.handle)}`);
}
