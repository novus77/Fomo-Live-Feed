import type { ActivitySource } from '../domain/activity';

const SOURCE_ASSETS = {
  fomo: { src: '/sources/fomo.svg', label: 'Fomo' },
  pump: { src: '/sources/pump.png', label: 'Pump' },
} as const satisfies Record<ActivitySource, { src: string; label: string }>;

export interface SourceIconProps {
  source: ActivitySource;
  className?: string;
}

export function SourceIcon({ source, className }: SourceIconProps) {
  const asset = SOURCE_ASSETS[source];
  const classes = ['source-icon', `source-icon-${source}`, className]
    .filter(Boolean)
    .join(' ');

  return <img className={classes} src={asset.src} alt={asset.label} />;
}
