import type { PipelineHealthSnapshotV1, PipelineRejectionCode } from '../background/pipeline-health';

export interface PipelineDiagnosticsProps {
  health: PipelineHealthSnapshotV1;
  now: () => number;
}

const rejectionLabels: Record<PipelineRejectionCode, string> = {
  schema_invalid: 'Invalid schema',
  duplicate: 'Duplicate',
  storage_failed: 'Storage failed',
  broadcast_failed: 'Broadcast failed',
};

function relativeTime(timestamp: number | undefined, now: number): string {
  if (timestamp === undefined) return 'Never';
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export function PipelineDiagnostics({ health, now }: PipelineDiagnosticsProps) {
  const currentTime = now();

  return (
    <section className="pipeline-diagnostics" aria-labelledby="pipeline-diagnostics-heading">
      <h2 id="pipeline-diagnostics-heading">Pipeline diagnostics</h2>
      <dl>
        <div><dt>Observer</dt><dd>{health.observerInstalled ? 'Observer ready' : 'Observer not ready'}</dd></div>
        <div><dt>Socket</dt><dd>{health.socketObserved ? `Socket observed / ${health.socketOpen ? 'open' : 'closed'}` : 'Socket not observed'}</dd></div>
        <div><dt>Last frame</dt><dd>{relativeTime(health.lastFrameAt, currentTime)}</dd></div>
        <div><dt>Last persisted</dt><dd>{relativeTime(health.lastPersistedAt, currentTime)}</dd></div>
        <div><dt>Newest event</dt><dd>{relativeTime(health.latestEventOccurredAt, currentTime)}</dd></div>
        <div><dt>Candidate</dt><dd>{health.activityCandidates}</dd></div>
        <div><dt>Accepted</dt><dd>{health.accepted}</dd></div>
        <div><dt>Rejected</dt><dd>{health.rejected}</dd></div>
        <div><dt>Duplicate</dt><dd>{health.duplicates}</dd></div>
        <div><dt>Persisted</dt><dd>{health.persisted}</dd></div>
        <div><dt>Broadcast</dt><dd>{health.broadcasts}</dd></div>
        <div><dt>Last rejection</dt><dd>{health.lastRejectionCode === undefined ? 'None' : rejectionLabels[health.lastRejectionCode]}</dd></div>
      </dl>
      {health.accepted > health.persisted && <p className="pipeline-stage-warning">Accepted activity is waiting for persistence.</p>}
      {health.persisted > health.broadcasts && <p className="pipeline-stage-warning">Persisted activity is waiting for broadcast.</p>}
    </section>
  );
}
