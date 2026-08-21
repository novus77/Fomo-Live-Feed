import type { MessageKey } from '../i18n/catalog';
import { useLocale } from '../i18n/LocaleProvider';
import type { PopupConnectionState } from '../popup/event-query';

const LABEL_KEYS: Record<PopupConnectionState, MessageKey> = {
  loading: 'connection.checking',
  connected: 'connection.connected',
  reconnecting: 'connection.reconnecting',
  offline: 'connection.offline',
  'login-required': 'connection.loginRequired',
};

export function ConnectionIndicator(props: { state: PopupConnectionState }) {
  const { translate } = useLocale();

  return (
    <span
      className={`connection-indicator connection-indicator-${props.state}`}
      role="status"
    >
      <span className="connection-indicator-dot" aria-hidden="true" />
      {translate(LABEL_KEYS[props.state])}
    </span>
  );
}
