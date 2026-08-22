import {
  ACTIVITY_REJECTION_STAGES,
  type ActivityRejectionStage,
} from '../background/diagnostics';
import type {
  PipelineHealthSnapshotV1,
  PipelineRejectionCode,
} from '../background/pipeline-health';
import type { MessageKey } from '../i18n/catalog';
import { useLocale } from '../i18n/LocaleProvider';

export interface PipelineDiagnosticsProps {
  health: PipelineHealthSnapshotV1;
  now: () => number;
}

/**
 * Stable stage-warning identifiers returned by the pure rule function. The
 * component maps each identifier to a localized message; keeping the parser
 * locale-independent makes the rule testable without a locale.
 */
export type PipelineStageWarning = 'accepted-waiting' | 'broadcast-waiting';

const WARNING_KEYS: Record<PipelineStageWarning, MessageKey> = {
  'accepted-waiting': 'diagnostics.warningWaitingPersist',
  'broadcast-waiting': 'diagnostics.warningWaitingBroadcast',
};

export function pipelineStageWarnings(
  health: PipelineHealthSnapshotV1,
): PipelineStageWarning[] {
  const warnings: PipelineStageWarning[] = [];
  const expectedPersisted = Math.max(
    0,
    health.accepted - health.duplicates - (health.storageFailures ?? 0),
  );
  const expectedBroadcasts = Math.max(
    0,
    health.persisted - (health.broadcastFailures ?? 0),
  );

  if (expectedPersisted > health.persisted) {
    warnings.push('accepted-waiting');
  }
  if (expectedBroadcasts > health.broadcasts) {
    warnings.push('broadcast-waiting');
  }
  return warnings;
}

const rejectionLabelKeys: Record<PipelineRejectionCode, MessageKey> = {
  schema_invalid: 'diagnostics.rejectionSchemaInvalid',
  duplicate: 'diagnostics.rejectionDuplicate',
  storage_failed: 'diagnostics.rejectionStorageFailed',
  broadcast_failed: 'diagnostics.rejectionBroadcastFailed',
};

// Settings evidence labels for the closed rejection stages (plan Task 2).
// These rows explain WHY live activities may be missing; they never carry a
// raw candidate, identity, address, amount, opinion, or URL.
const rejectionStageLabelKeys: Record<ActivityRejectionStage, MessageKey> = {
  'observer-topic': 'diagnostics.stageObserverTopic',
  'bridge-envelope': 'diagnostics.stageBridgeEnvelope',
  'raw-schema': 'diagnostics.stageRawSchema',
  normalization: 'diagnostics.stageNormalization',
  deduplication: 'diagnostics.stageDeduplication',
  storage: 'diagnostics.stageStorage',
  broadcast: 'diagnostics.stageBroadcast',
};

function relativeTime(
  timestamp: number | undefined,
  now: number,
  translate: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string,
): string {
  if (timestamp === undefined) return translate('diagnostics.never');
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return translate('diagnostics.secondsAgo', { seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return translate('diagnostics.minutesAgo', { minutes });
  return translate('diagnostics.hoursAgo', { hours: Math.floor(minutes / 60) });
}

export function PipelineDiagnostics({ health, now }: PipelineDiagnosticsProps) {
  const { translate } = useLocale();
  const currentTime = now();
  const warnings = pipelineStageWarnings(health);

  // Closed-stage evidence rows, in the fixed stage order, for stages with at
  // least one rejection.
  const stageRows = ACTIVITY_REJECTION_STAGES.map((stage) => ({
    stage,
    count: health.rejectionStages?.[stage] ?? 0,
  })).filter((row) => row.count > 0);

  // Unknown-network aggregates, most recently seen first. The numeric ID is
  // evidence text here; it is never rendered as a trusted chain badge.
  const unknownNetworkRows = [...(health.unknownNetworkAggregates ?? [])].sort(
    (left, right) => right.lastSeenAt - left.lastSeenAt,
  );

  const socketState = health.socketOpen
    ? translate('diagnostics.open')
    : translate('diagnostics.closed');

  return (
    <section className="pipeline-diagnostics" aria-labelledby="pipeline-diagnostics-heading">
      <h2 id="pipeline-diagnostics-heading">{translate('diagnostics.title')}</h2>
      <dl>
        <div><dt>{translate('diagnostics.observer')}</dt><dd>{health.observerInstalled ? translate('diagnostics.observerReady') : translate('diagnostics.observerNotReady')}</dd></div>
        <div><dt>{translate('diagnostics.socket')}</dt><dd>{health.socketObserved ? translate('diagnostics.socketObserved', { state: socketState }) : translate('diagnostics.socketNotObserved')}</dd></div>
        <div><dt>{translate('diagnostics.lastFrame')}</dt><dd>{relativeTime(health.lastFrameAt, currentTime, translate)}</dd></div>
        <div><dt>{translate('diagnostics.lastPersisted')}</dt><dd>{relativeTime(health.lastPersistedAt, currentTime, translate)}</dd></div>
        <div><dt>{translate('diagnostics.newestEvent')}</dt><dd>{relativeTime(health.latestEventOccurredAt, currentTime, translate)}</dd></div>
        <div><dt>{translate('diagnostics.candidate')}</dt><dd>{health.activityCandidates}</dd></div>
        <div><dt>{translate('diagnostics.accepted')}</dt><dd>{health.accepted}</dd></div>
        <div><dt>{translate('diagnostics.rejected')}</dt><dd>{health.rejected}</dd></div>
        <div><dt>{translate('diagnostics.duplicate')}</dt><dd>{health.duplicates}</dd></div>
        <div><dt>{translate('diagnostics.persisted')}</dt><dd>{health.persisted}</dd></div>
        <div><dt>{translate('diagnostics.broadcast')}</dt><dd>{health.broadcasts}</dd></div>
        <div><dt>{translate('diagnostics.lastRejection')}</dt><dd>{health.lastRejectionCode === undefined ? translate('diagnostics.none') : translate(rejectionLabelKeys[health.lastRejectionCode])}</dd></div>
        {stageRows.map(({ stage, count }) => (
          <div key={stage}>
            <dt>{translate(rejectionStageLabelKeys[stage])}</dt>
            <dd>{count}</dd>
          </div>
        ))}
        {unknownNetworkRows.map((entry) => (
          <div key={entry.networkId}>
            <dt>{translate('diagnostics.unknownNetwork', { networkId: entry.networkId })}</dt>
            <dd>{translate('diagnostics.unknownNetworkDetail', { count: entry.count, time: relativeTime(entry.lastSeenAt, currentTime, translate) })}</dd>
          </div>
        ))}
      </dl>
      {warnings.map((warning) => (
        <p className="pipeline-stage-warning" key={warning}>{translate(WARNING_KEYS[warning])}</p>
      ))}
    </section>
  );
}
