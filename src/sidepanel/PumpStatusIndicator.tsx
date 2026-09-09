import type { MessageKey } from '../i18n/catalog';
import { useLocale } from '../i18n/LocaleProvider';
import type { PumpConnectionStatus } from '../messaging/protocol';
import { SourceIcon } from './SourceIcon';

const LABEL_KEYS: Record<PumpConnectionStatus, MessageKey> = {
  live: 'pumpStatus.live',
  'catching-up': 'pumpStatus.catchingUp',
  delayed: 'pumpStatus.delayed',
  'rate-limited': 'pumpStatus.rateLimited',
  'authentication-required': 'pumpStatus.authenticationRequired',
  'protocol-incompatible': 'pumpStatus.protocolIncompatible',
  'possible-gap': 'pumpStatus.possibleGap',
  disconnected: 'pumpStatus.disconnected',
};

export function PumpStatusIndicator(props: { status: PumpConnectionStatus }) {
  const { translate } = useLocale();
  const label = `Pump: ${translate(LABEL_KEYS[props.status])}`;

  return (
    <span
      className={`pump-status-indicator pump-status-${props.status}`}
      role="status"
      aria-label={label}
      title={label}
    >
      <SourceIcon source="pump" className="pump-status-source-icon" />
      <span className="pump-status-dot" aria-hidden="true" />
    </span>
  );
}
