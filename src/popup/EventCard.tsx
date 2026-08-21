import { useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import type { TradeEventV1 } from '../domain/activity';
import {
  ANNOTATION_COLORS,
  type TraderAnnotationUpdate,
  type TraderAnnotationV1,
} from '../domain/annotations';
import type { LocalSettingsV3 } from '../domain/settings';
import { useLocale } from '../i18n/LocaleProvider';
import {
  Avatar,
  TokenImage,
  ACTION_LABEL_KEYS,
} from '../overlay/presentation';
import {
  buildFomoProfileUrl,
  buildFomoTokenUrl,
} from '../navigation/fomo-links';
import {
  formatFollowers,
  formatRelativeTime,
  formatUsd,
} from '../overlay/format';
import type { BrowserTranslationApi } from '../translation/browser-translation';
import type { OpinionTranslationCoordinator } from '../translation/opinion-translation';
import { ChainBadge } from '../sidepanel/ChainBadge';
import { CopyableAddress } from '../sidepanel/CopyableAddress';
import { TranslatedOpinion } from '../sidepanel/TranslatedOpinion';
import { TraderAnnotationEditor } from './TraderAnnotationEditor';

/**
 * History card (plan Task 9/10, spec sections 7.2 and 7.3).
 *
 * Shows trader identity (with optional inline followers), action/token/chain,
 * amount, relative time, optional translated opinion, annotation editor, and
 * the verified CA copy action. Every URL comes from the verified builders and
 * every untrusted value renders as text.
 *
 * Plan Task 7: when the event carries a `thesis`, the card delegates the
 * on-device translation surface to `TranslatedOpinion` (original-first,
 * translated-primary with a View original toggle, and activation /
 * unavailable states). Toasts never translate - only this Side Panel history
 * card owns the translated view.
 */

export interface EventCardProps {
  event: TradeEventV1;
  settings: LocalSettingsV3;
  annotation: TraderAnnotationV1 | undefined;
  now: () => number;
  copyText: (text: string) => Promise<void>;
  openLink: (url: URL) => void;
  /**
   * The side panel's shared on-device translation adapter (plan Task 7).
   * When omitted (legacy popup harness, tests) TranslatedOpinion builds its
   * own.
   */
  translationApi?: BrowserTranslationApi;
  /**
   * The side panel's shared on-device translation coordinator (ONE per
   * panel, plan Task 7). When omitted the card owns a per-card coordinator.
   */
  translationCoordinator?: OpinionTranslationCoordinator;
  onUpsertAnnotation: (traderId: string, update: TraderAnnotationUpdate) => void;
  onDeleteAnnotation: (traderId: string) => void;
}

export function EventCard(props: EventCardProps) {
  const { event, settings, annotation, now, copyText, openLink } = props;
  const { translate } = useLocale();

  const [showEditor, setShowEditor] = useState(false);

  const tokenUrl = buildFomoTokenUrl(event.chain, event.tokenAddress);
  const profileUrl = buildFomoProfileUrl(event.traderHandle);

  const traderName = event.traderName ?? event.traderHandle;
  const followers = formatFollowers(event.metricSnapshot?.followers);

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
        <span className="event-trader-handle">
          @{event.traderHandle}
          {followers !== undefined && (
            <span className="event-trader-followers">
              {' · '}
              {translate('card.followers', { count: followers })}
            </span>
          )}
        </span>
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
          aria-label={translate('card.editLabel')}
          onClick={handleEditorToggle}
        >
          {showEditor ? translate('card.close') : translate('card.label')}
        </button>
      </header>

      <div className="event-action-line">
        <span className={'event-action event-action-' + event.action}>
          {translate(ACTION_LABEL_KEYS[event.action])}
        </span>
        <TokenImage
          url={event.tokenImageUrl}
          symbol={event.tokenSymbol}
          imageClassName="event-token-image"
          fallbackClassName="event-token-fallback"
        />
        <span className="event-token-symbol">${event.tokenSymbol}</span>
        <ChainBadge chain={event.chain} className="event-chain-badge" />
        <span className="event-amount">{formatUsd(event.usdAmount)}</span>
        <span className="event-time">{formatRelativeTime(event.occurredAt, now())}</span>
      </div>

      {event.thesis !== undefined && (
        <TranslatedOpinion
          text={event.thesis}
          enabled={settings.opinionTranslation.enabled}
          targetLanguage={settings.opinionTranslation.targetLanguage}
          {...(props.translationApi !== undefined
            ? { translationApi: props.translationApi }
            : {})}
          {...(props.translationCoordinator !== undefined
            ? { translationCoordinator: props.translationCoordinator }
            : {})}
        />
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

      <footer className="event-footer">
        <CopyableAddress
          chain={event.chain}
          address={event.tokenAddress}
          copyText={copyText}
        />
      </footer>
    </article>
  );
}
