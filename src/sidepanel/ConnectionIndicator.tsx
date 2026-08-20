import type { PopupConnectionState } from '../popup/event-query';

const LABELS: Record<PopupConnectionState, string> = {
  loading: 'Checking…',
  connected: 'Connected',
  reconnecting: 'Reconnecting',
  offline: 'Offline',
  'login-required': 'Login required',
};

export function ConnectionIndicator(props: { state: PopupConnectionState }) {
  return (
    <span
      className={`connection-indicator connection-indicator-${props.state}`}
      role="status"
    >
      <span className="connection-indicator-dot" aria-hidden="true" />
      {LABELS[props.state]}
    </span>
  );
}
