import { useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import type {
  ActivityAction,
  ChainKey,
  MetricSnapshotV1,
  TradeEventV1,
} from '../domain/activity';
import { ANNOTATION_COLORS, type TraderAnnotationV1 } from '../domain/annotations';
import type { LocalSettingsV1, MetricKey } from '../domain/settings';
import {
  shortenContractAddress,
  validateContractAddress,
} from '../navigation/contract-address';
import {
  buildFomoProfileUrl,
  buildFomoTokenUrl,
} from '../navigation/fomo-links';
import {
  formatMetricLabel,
  formatMetricValue,
  formatRelativeTime,
  formatUsd,
} from './format';

const CHAIN_LABELS: Readonly<Record<ChainKey, string>> = {
  solana: 'Solana',
  ethereum: 'Ethereum',
  bsc: 'BSC',
  base: 'Base',
  monad: 'Monad',
  unknown: 'Unknown',
};

const ACTION_LABELS: Readonly<Record<ActivityAction, string>> = {
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
function initialsFor(name: string | undefined, handle: string): string {
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

interface AvatarProps {
  url: string | undefined;
  name: string | undefined;
  handle: string;
}

function Avatar({ url, name, handle }: AvatarProps) {
  const [failed, setFailed] = useState(false);

  if (url === undefined || failed) {
    return <span className="toast-avatar-fallback">{initialsFor(name, handle)}</span>;
  }

  return (
    <img
      className="toast-avatar"
      src={url}
      alt=""
      onError={() => {
        setFailed(true);
      }}
    />
  );
}

interface TokenImageProps {
  url: string | undefined;
  symbol: string;
}

function TokenImage({ url, symbol }: TokenImageProps) {
  const [failed, setFailed] = useState(false);

  if (url === undefined || failed) {
    return <span className="toast-token-fallback">{symbol}</span>;
  }

  return (
    <img
      className="toast-token-image"
      src={url}
      alt=""
      onError={() => {
        setFailed(true);
      }}
    />
  );
}

function readMetric(
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

export interface ToastStackProps {
  /** Visible cards, oldest-to-newest; the queue already enforces the cap of three. */
  events: readonly TradeEventV1[];
  /** Settings drive which two metrics (if any) each card shows. */
  settings: LocalSettingsV1;
  /** Trader annotations keyed by stable trader id, for custom labels. */
  annotations?: ReadonlyMap<string, TraderAnnotationV1>;
  /** Injected clock so relative time is deterministic in tests. */
  now: () => number;
  /** Injected clipboard writer; receives the COMPLETE validated address. */
  copyText: (text: string) => Promise<void>;
  /** Injected navigation opener; defaults to a noopener window.open. */
  openLink?: (url: URL) => void;
  onClose?: (id: string) => void;
  onHoverChange?: (id: string | null) => void;
}

export function ToastStack(props: ToastStackProps) {
  const { events, settings, annotations, now, copyText, onClose, onHoverChange } = props;
  const openLink =
    props.openLink ??
    ((url: URL) => {
      window.open(url.href, '_blank', 'noopener,noreferrer');
    });

  return (
    <div className="toast-stack">
      {events.map((event) => (
        <ToastCard
          key={event.id}
          event={event}
          settings={settings}
          annotation={annotations?.get(event.traderId)}
          now={now}
          copyText={copyText}
          openLink={openLink}
          onClose={onClose ?? (() => {})}
          onHoverChange={onHoverChange ?? (() => {})}
        />
      ))}
    </div>
  );
}

interface ToastCardProps {
  event: TradeEventV1;
  settings: LocalSettingsV1;
  annotation: TraderAnnotationV1 | undefined;
  now: () => number;
  copyText: (text: string) => Promise<void>;
  openLink: (url: URL) => void;
  onClose: (id: string) => void;
  onHoverChange: (id: string | null) => void;
}

function ToastCard({
  event,
  settings,
  annotation,
  now,
  copyText,
  openLink,
  onClose,
  onHoverChange,
}: ToastCardProps) {
  // Every URL comes from the verified builders; a null result means the card
  // renders WITHOUT a link rather than a broken or unsafe one (spec section 9).
  const addressValidation = validateContractAddress(event.chain, event.tokenAddress);
  const shortenedAddress = addressValidation.ok
    ? shortenContractAddress(addressValidation)
    : undefined;
  const tokenUrl = buildFomoTokenUrl(event.chain, event.tokenAddress);
  const profileUrl = buildFomoProfileUrl(event.traderHandle);

  const metricKeys = [settings.metrics.primary, settings.metrics.secondary].filter(
    (key): key is MetricKey => key !== undefined,
  );

  const traderName = event.traderName ?? event.traderHandle;

  const labelStyle =
    annotation?.color !== undefined &&
    (ANNOTATION_COLORS as readonly string[]).includes(annotation.color)
      ? { backgroundColor: annotation.color }
      : undefined;

  const handleCardClick = (): void => {
    if (tokenUrl !== null) {
      openLink(tokenUrl);
    }
  };

  const handleProfileClick = (mouseEvent: ReactMouseEvent): void => {
    mouseEvent.stopPropagation();
  };

  const handleCopyClick = (mouseEvent: ReactMouseEvent): void => {
    mouseEvent.stopPropagation();

    if (addressValidation.ok) {
      void copyText(addressValidation.canonical);
    }
  };

  const handleCloseClick = (mouseEvent: ReactMouseEvent): void => {
    mouseEvent.stopPropagation();
    onClose(event.id);
  };

  const identity = (
    <>
      <Avatar
        url={event.traderAvatarUrl}
        name={event.traderName}
        handle={event.traderHandle}
      />
      <span className="toast-identity-text">
        <span className="toast-trader-name">{traderName}</span>
        <span className="toast-trader-handle">@{event.traderHandle}</span>
      </span>
    </>
  );

  return (
    <article
      className="toast-card"
      onClick={handleCardClick}
      onMouseEnter={() => {
        onHoverChange(event.id);
      }}
      onMouseLeave={() => {
        onHoverChange(null);
      }}
    >
      <header className="toast-card-header">
        {profileUrl !== null ? (
          <a
            className="toast-identity"
            href={profileUrl.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleProfileClick}
          >
            {identity}
          </a>
        ) : (
          <span className="toast-identity">{identity}</span>
        )}
        {annotation?.label !== undefined && (
          <span className="toast-trader-label" style={labelStyle}>
            {annotation.label}
          </span>
        )}
        <button
          type="button"
          className="toast-close"
          aria-label="Dismiss toast"
          onClick={handleCloseClick}
        >
          ×
        </button>
      </header>

      <div className="toast-action-line">
        <span className={'toast-action toast-action-' + event.action}>
          {ACTION_LABELS[event.action]}
        </span>
        <TokenImage url={event.tokenImageUrl} symbol={event.tokenSymbol} />
        <span className="toast-token-symbol">${event.tokenSymbol}</span>
        <span className="toast-chain-badge">{CHAIN_LABELS[event.chain]}</span>
        <span className="toast-amount">{formatUsd(event.usdAmount)}</span>
        <span className="toast-time">{formatRelativeTime(event.occurredAt, now())}</span>
      </div>

      {event.thesis !== undefined && <p className="toast-thesis">{event.thesis}</p>}

      {metricKeys.length > 0 && (
        <div className="toast-metrics">
          {metricKeys.map((key) => (
            <div key={key} className="toast-metric">
              <span className="toast-metric-label">{formatMetricLabel(key)}</span>
              <span className="toast-metric-value">
                {formatMetricValue(key, readMetric(event.metricSnapshot, key))}
              </span>
            </div>
          ))}
        </div>
      )}

      {shortenedAddress !== undefined && (
        <footer className="toast-footer">
          <button
            type="button"
            className="toast-address"
            aria-label="Copy full address"
            title="Copy full address"
            onClick={handleCopyClick}
          >
            {shortenedAddress}
          </button>
        </footer>
      )}
    </article>
  );
}
