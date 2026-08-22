import { useState } from 'react';

import type {
  ActivityAction,
  ChainKey,
} from '../domain/activity';
import type { MessageKey } from '../i18n/catalog';
import { CHAIN_PRESENTATION } from '../sidepanel/chain-presentation';

/**
 * Shared card presentation helpers (SHOULD-FIX 5).
 *
 * Side Panel history cards render trader identity, token images, and
 * action/chain labels through this module, so fallback and HTTPS allowlist
 * fixes land in exactly one place.
 */

export const CHAIN_LABELS: Readonly<Record<ChainKey, string>> = Object.fromEntries(
  Object.entries(CHAIN_PRESENTATION).map(([chain, value]) => [chain, value.label]),
) as Record<ChainKey, string>;

export const ACTION_LABELS: Readonly<Record<ActivityAction, string>> = {
  buy: 'Buy',
  sell: 'Sell',
  withdraw: 'Withdraw',
  transfer: 'Transfer',
  thesis: 'Thesis',
};

/**
 * Message keys for the closed-set action labels. Chain labels are proper
 * nouns (BSC, SOL, ETH, …) and stay locale-independent; action words are
 * extension-owned copy, so surfaces render `translate(ACTION_LABEL_KEYS[action])`.
 */
export const ACTION_LABEL_KEYS: Readonly<Record<ActivityAction, MessageKey>> = {
  buy: 'action.buy',
  sell: 'action.sell',
  withdraw: 'action.withdraw',
  transfer: 'action.transfer',
  thesis: 'action.thesis',
};

/**
 * Deterministic initials fallback for the trader avatar (plan Task 8 step 4,
 * spec section 10): the first letters of the first and last word of the
 * display name, or the handle when no display name exists. Same input always
 * yields the same output.
 */
export function initialsFor(name: string | undefined, handle: string): string {
  const source = (name ?? handle).trim();

  if (source.length === 0) {
    return '?';
  }

  const parts = source.split(/\s+/);
  const first = parts[0] ?? '';
  const firstInitial = first.slice(0, 1).toUpperCase();

  if (parts.length < 2) {
    return firstInitial;
  }

  const last = parts[parts.length - 1] ?? '';

  if (last === first || last.length === 0) {
    return firstInitial;
  }

  return firstInitial + last.slice(0, 1).toUpperCase();
}

/**
 * NIT: avatar/token image sources are restricted to https. A non-https (or
 * unparseable) URL renders the deterministic fallback instead of an <img>, so
 * a hostile or corrupted stored URL can never become a network request.
 */
export function isHttpsImageUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

export interface IdentityImageProps {
  url: string | undefined;
  name: string | undefined;
  handle: string;
  /** Class for the rendered <img> (each surface styles its own). */
  imageClassName: string;
  /** Class for the initials fallback span. */
  fallbackClassName: string;
}

export function Avatar({
  url,
  name,
  handle,
  imageClassName,
  fallbackClassName,
}: IdentityImageProps) {
  const [failed, setFailed] = useState(false);

  if (url === undefined || failed || !isHttpsImageUrl(url)) {
    return <span className={fallbackClassName}>{initialsFor(name, handle)}</span>;
  }

  return (
    <img
      className={imageClassName}
      src={url}
      alt=""
      onError={() => {
        setFailed(true);
      }}
    />
  );
}

export interface TokenImageProps {
  url: string | undefined;
  symbol: string;
  imageClassName: string;
  fallbackClassName: string;
}

export function TokenImage({
  url,
  symbol,
  imageClassName,
  fallbackClassName,
}: TokenImageProps) {
  const [failed, setFailed] = useState(false);

  if (url === undefined || failed || !isHttpsImageUrl(url)) {
    return <span className={fallbackClassName}>{symbol}</span>;
  }

  return (
    <img
      className={imageClassName}
      src={url}
      alt=""
      onError={() => {
        setFailed(true);
      }}
    />
  );
}
