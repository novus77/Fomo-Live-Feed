import { useState } from 'react';

import type {
  ActivityAction,
  ChainKey,
  MetricSnapshotV1,
} from '../domain/activity';
import type { MetricKey } from '../domain/settings';
import { CHAIN_PRESENTATION } from '../sidepanel/chain-presentation';

/**
 * Shared card presentation helpers (SHOULD-FIX 5).
 *
 * The popup history card (EventCard) and the overlay toast card (ToastStack)
 * render the same trader identity, token image, action/chain labels, and
 * metric projection. These were verbatim copies that had already drifted in
 * class names; this module is the SINGLE implementation both surfaces consume
 * (each passes its own class names), so a fix to the fallback logic or the
 * https allowlist lands in exactly one place.
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
 * Projects the configured metric key onto the snapshot value, or undefined
 * when the snapshot (or that window) is missing - the formatters then render
 * Unavailable, never zero.
 */
export function readMetric(
  snapshot: MetricSnapshotV1 | undefined,
  key: MetricKey,
): number | undefined {
  if (snapshot === undefined) {
    return undefined;
  }

  switch (key) {
    case 'pnl7d':
      return snapshot.pnl7d;
    case 'winRate7d':
      return snapshot.winRate7d;
    case 'followers':
      return snapshot.followers;
    case 'tradeCount':
      return snapshot.tradeCount;
    case 'averageHoldSeconds':
      return snapshot.averageHoldSeconds;
  }
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
