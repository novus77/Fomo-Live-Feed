import type { MessageKey } from '../i18n/catalog';
import { useLocale } from '../i18n/LocaleProvider';
import type { PumpConnectionStatus, PumpGapSummary } from '../messaging/protocol';
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

const GAP_LABEL_KEYS: Record<PumpGapSummary['reason'], MessageKey> = {
  'age-limit': 'pumpGap.ageLimit',
  'event-limit': 'pumpGap.eventLimit',
  'endpoint-ended': 'pumpGap.endpointEnded',
  'cursor-loop': 'pumpGap.cursorLoop',
  unspecified: 'pumpGap.unspecified',
};

export function PumpStatusIndicator(props: {
  status: PumpConnectionStatus;
  hasUnresolvedGap?: boolean;
  gap?: PumpGapSummary;
}) {
  const { translate } = useLocale();
  const label = `Pump: ${translate(LABEL_KEYS[props.status])}${
    props.hasUnresolvedGap === true ? ` · ${translate('pumpStatus.historyGap')}` : ''
  }`;
  const title = props.hasUnresolvedGap === true && props.gap !== undefined
    ? `${label} · ${translate(GAP_LABEL_KEYS[props.gap.reason])} · ${new Date(props.gap.lastGapAt).toLocaleString()}`
    : label;

  return (
    <span
      className={`pump-status-indicator pump-status-${props.status}`}
      role="status"
      aria-label={label}
      title={title}
    >
      <SourceIcon source="pump" className="pump-status-source-icon" />
      <span className="pump-status-dot" aria-hidden="true" />
      {props.hasUnresolvedGap === true && (
        <span className="pump-status-gap-mark" aria-hidden="true">!</span>
      )}
    </span>
  );
}
