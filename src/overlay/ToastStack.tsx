import { useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import type { TradeEventV1 } from '../domain/activity';
import { ANNOTATION_COLORS, type TraderAnnotationV1 } from '../domain/annotations';
import type { LocalSettingsV1, MetricKey } from '../domain/settings';
import {
  ACTION_LABELS,
  Avatar,
  readMetric,
  TokenImage,
} from './presentation';
import { ChainBadge } from '../sidepanel/ChainBadge';
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
        imageClassName="toast-avatar"
        fallbackClassName="toast-avatar-fallback"
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
        <TokenImage
          url={event.tokenImageUrl}
          symbol={event.tokenSymbol}
          imageClassName="toast-token-image"
          fallbackClassName="toast-token-fallback"
        />
        <span className="toast-token-symbol">${event.tokenSymbol}</span>
        <ChainBadge chain={event.chain} className="toast-chain-badge" />
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
