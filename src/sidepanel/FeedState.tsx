import type { ReactNode } from 'react';

export interface FeedStateProps {
  tone: 'empty' | 'error' | 'info';
  message: string;
  icon?: ReactNode;
  actionLabel?: string;
  onAction?: () => void;
}

export function FeedState(props: FeedStateProps) {
  const role = props.tone === 'error' ? 'alert' : 'status';

  return (
    <div className={`feed-state feed-state-${props.tone}`} role={role}>
      {props.icon !== undefined && (
        <span className="feed-state-icon" aria-hidden="true">
          {props.icon}
        </span>
      )}
      <span className="feed-state-message">{props.message}</span>
      {props.actionLabel !== undefined && props.onAction !== undefined && (
        <button type="button" className="feed-state-action" onClick={props.onAction}>
          {props.actionLabel}
        </button>
      )}
    </div>
  );
}

export function FeedSkeleton(props: { rows?: number; loadingLabel: string }) {
  const rows = props.rows ?? 3;

  return (
    <div
      className="feed-skeleton"
      role="status"
      aria-live="polite"
      aria-label={props.loadingLabel}
    >
      <span className="visually-hidden">{props.loadingLabel}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div className="feed-skeleton-card" aria-hidden="true" key={index}>
          <span className="feed-skeleton-avatar" />
          <span className="feed-skeleton-line feed-skeleton-line-primary" />
          <span className="feed-skeleton-line feed-skeleton-line-secondary" />
        </div>
      ))}
    </div>
  );
}
