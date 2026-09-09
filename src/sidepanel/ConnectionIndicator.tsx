import type { MessageKey } from '../i18n/catalog';
import { useLocale } from '../i18n/LocaleProvider';
import type { PopupConnectionState } from '../popup/event-query';
import { SourceIcon } from './SourceIcon';

const LABEL_KEYS: Record<PopupConnectionState, MessageKey> = {
  loading: 'connection.checking',
  connected: 'connection.connected',
  reconnecting: 'connection.reconnecting',
  offline: 'connection.offline',
  'login-required': 'connection.loginRequired',
};

export function ConnectionIndicator(props: { state: PopupConnectionState }) {
  const { translate } = useLocale();
  const label = translate(LABEL_KEYS[props.state]);
  const accessibleLabel = `Fomo: ${label}`;

  return (
    <span
      className={`connection-indicator connection-indicator-${props.state}`}
      role="status"
      aria-label={accessibleLabel}
      title={accessibleLabel}
    >
      <SourceIcon source="fomo" className="connection-source-icon" />
      <span className="connection-indicator-dot" aria-hidden="true" />
      <span className="visually-hidden">{label}</span>
    </span>
  );
}
