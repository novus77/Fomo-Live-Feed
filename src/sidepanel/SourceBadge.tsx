import { getEventSources, type ActivitySource, type TradeEventV1 } from '../domain/activity';
import { SourceIcon } from './SourceIcon';

export function projectedEventSources(
  event: TradeEventV1,
  filter: 'all' | ActivitySource,
): ActivitySource[] {
  const sources = getEventSources(event);
  return filter === 'all' ? sources : sources.filter((source) => source === filter);
}

export function SourceBadge(props: {
  event: TradeEventV1;
  filter?: 'all' | ActivitySource;
  placement?: 'inline' | 'avatar' | 'identity';
  decorative?: boolean;
}) {
  const sources = projectedEventSources(props.event, props.filter ?? 'all');
  if (sources.length === 0) return null;
  const label = sources.map((source) => source === 'fomo' ? 'Fomo' : 'Pump').join(' + ');
  const placement = props.placement ?? 'inline';
  return (
    <span
      className={`event-source-badge event-source-badge-${placement}`}
      {...(props.decorative ? { 'aria-hidden': true } : { 'aria-label': label })}
    >
      {sources.map((source) => <SourceIcon key={source} source={source} />)}
    </span>
  );
}
