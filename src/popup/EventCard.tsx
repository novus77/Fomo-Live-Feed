import { useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import type { TradeEventV1 } from '../domain/activity';
import {
  ANNOTATION_COLORS,
  type TraderAnnotationUpdate,
  type TraderAnnotationV1,
} from '../domain/annotations';
import type { LocalSettingsV1, MetricKey } from '../domain/settings';
import {
  Avatar,
  readMetric,
  TokenImage,
} from '../overlay/presentation';
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
} from '../overlay/format';
import { ACTION_LABELS, CHAIN_LABELS } from './labels';
import { TraderAnnotationEditor } from './TraderAnnotationEditor';

/**
 * History card (plan Task 9/10, spec sections 7.2 and 7.3).
 *
 * Shows the same fields as the toast card plus read state, an annotation
 * editor, and the same verified navigation/copy actions. Every URL comes
 * from the verified builders and every untrusted value renders as text.
 */

export interface EventCardProps {
  event: TradeEventV1;
  settings: LocalSettingsV1;
  annotation: TraderAnnotationV1 | undefined;
  now: () => number;
  copyText: (text: string) => Promise<void>;
  openLink: (url: URL) => void;
  onUpsertAnnotation: (traderId: string, update: TraderAnnotationUpdate) => void;
  onDeleteAnnotation: (traderId: string) => void;
}

export function EventCard(props: EventCardProps) {
  const { event, settings, annotation, now, copyText, openLink } = props;

  const [showEditor, setShowEditor] = useState(false);

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
    if (tokenUrl !== null && !showEditor) {
      openLink(tokenUrl);
    }
  };

  const handleProfileClick = (mouseEvent: ReactMouseEvent): void => {
    mouseEvent.stopPropagation();
  };

  const handleCopyClick = (mouseEvent: ReactMouseEvent): void => {
    mouseEvent.stopPropagation();

    if (addressValidation.ok) {
      void copyText(addressValidation.canonical).catch(() => {});
    }
  };

  const handleEditorToggle = (mouseEvent: ReactMouseEvent): void => {
    mouseEvent.stopPropagation();
    setShowEditor((visible) => !visible);
  };

  const identity = (
    <>
      <Avatar
        url={event.traderAvatarUrl}
        name={event.traderName}
        handle={event.traderHandle}
        imageClassName="event-avatar-image"
        fallbackClassName="event-avatar"
      />
      <span className="event-identity-text">
        <span className="event-trader-name">{traderName}</span>
        <span className="event-trader-handle">@{event.traderHandle}</span>
      </span>
    </>
  );

  return (
    <article
      className={'event-card' + (event.readAt === undefined ? ' event-card-unread' : '')}
      data-event-id={event.id}
      onClick={handleCardClick}
    >
      <header className="event-card-header">
        {profileUrl !== null ? (
          <a
            className="event-identity"
            href={profileUrl.href}
            target="_blank"
            rel="noopener noreferrer"
            onClick={handleProfileClick}
          >
            {identity}
          </a>
        ) : (
          <span className="event-identity">{identity}</span>
        )}
        {annotation?.label !== undefined && (
          <span className="event-trader-label" style={labelStyle}>
            {annotation.label}
          </span>
        )}
        <button
          type="button"
          className="event-edit-label"
          aria-label="Edit label"
          onClick={handleEditorToggle}
        >
          {showEditor ? 'Close' : 'Label'}
        </button>
      </header>

      <div className="event-action-line">
        <span className={'event-action event-action-' + event.action}>
          {ACTION_LABELS[event.action]}
        </span>
        <TokenImage
          url={event.tokenImageUrl}
          symbol={event.tokenSymbol}
          imageClassName="event-token-image"
          fallbackClassName="event-token-fallback"
        />
        <span className="event-token-symbol">${event.tokenSymbol}</span>
        <span className="event-chain-badge">{CHAIN_LABELS[event.chain]}</span>
        <span className="event-amount">{formatUsd(event.usdAmount)}</span>
        <span className="event-time">{formatRelativeTime(event.occurredAt, now())}</span>
      </div>

      {event.thesis !== undefined && <p className="event-thesis">{event.thesis}</p>}

      {metricKeys.length > 0 && (
        <div className="event-metrics">
          {metricKeys.map((key) => (
            <div key={key} className="event-metric">
              <span className="event-metric-label">{formatMetricLabel(key)}</span>
              <span className="event-metric-value">
                {formatMetricValue(key, readMetric(event.metricSnapshot, key))}
              </span>
            </div>
          ))}
        </div>
      )}

      {showEditor && (
        <TraderAnnotationEditor
          annotation={annotation}
          onSaveLabel={(label) => {
            props.onUpsertAnnotation(event.traderId, { label });
          }}
          onSelectColor={(color) => {
            props.onUpsertAnnotation(event.traderId, { color });
          }}
          onTogglePin={(pinned) => {
            props.onUpsertAnnotation(event.traderId, { pinned });
          }}
          onToggleMute={(muted) => {
            props.onUpsertAnnotation(event.traderId, { muted });
          }}
          onDelete={() => {
            props.onDeleteAnnotation(event.traderId);
          }}
        />
      )}

      {shortenedAddress !== undefined && (
        <footer className="event-footer">
          <button
            type="button"
            className="event-address"
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
