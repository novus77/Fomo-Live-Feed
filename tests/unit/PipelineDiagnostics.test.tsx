import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import {
  PipelineDiagnostics,
  pipelineStageWarnings,
} from '../../src/sidepanel/PipelineDiagnostics';

describe('PipelineDiagnostics', () => {
  it('renders closed pipeline health without exposing raw activity values', () => {
    const snapshot = {
      schemaVersion: 1 as const,
      observerInstalled: true,
      socketObserved: true,
      socketOpen: false,
      lastFrameAt: 1_800_000_000_000 - 2_000,
      lastPersistedAt: 1_800_000_000_000 - 5_000,
      latestEventOccurredAt: 1_800_000_000_000 - 8_000,
      activityCandidates: 7,
      accepted: 6,
      rejected: 1,
      duplicates: 1,
      persisted: 5,
      broadcasts: 4,
      lastRejectionCode: 'duplicate' as const,
      lastRejectedAt: 1_800_000_000_000 - 1_000,
    };

    render(<PipelineDiagnostics health={snapshot} now={() => 1_800_000_000_000} />);

    expect(screen.getByRole('heading', { name: 'Pipeline diagnostics' })).toBeInTheDocument();
    expect(screen.getByText('Observer ready')).toBeInTheDocument();
    expect(screen.getByText('Socket observed / closed')).toBeInTheDocument();
    expect(screen.getByText('2s ago')).toBeInTheDocument();
    expect(screen.getByText('5s ago')).toBeInTheDocument();
    expect(screen.getAllByText('Duplicate')).toHaveLength(2);
    expect(screen.queryByText(/accepted activity is waiting for persistence/i)).not.toBeInTheDocument();
    expect(screen.getByText(/persisted activity is waiting for broadcast/i)).toBeInTheDocument();
    expect(JSON.stringify(document.body.textContent)).not.toContain('tokenAddress');
    expect(document.body.textContent).not.toContain('0x');
  });

  it('renders the observer-not-ready and never-observed states neutrally', () => {
    render(<PipelineDiagnostics health={{
      schemaVersion: 1,
      observerInstalled: false,
      socketObserved: false,
      socketOpen: false,
      activityCandidates: 0,
      accepted: 0,
      rejected: 0,
      duplicates: 0,
      persisted: 0,
      broadcasts: 0,
    }} now={() => 1_800_000_000_000} />);

    expect(screen.getByText('Observer not ready')).toBeInTheDocument();
    expect(screen.getByText('Socket not observed')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('treats duplicate and failed terminal outcomes as settled stages', () => {
    const base = {
      schemaVersion: 1 as const,
      observerInstalled: true,
      socketObserved: true,
      socketOpen: true,
      activityCandidates: 7,
      accepted: 6,
      rejected: 2,
      duplicates: 1,
      schemaRejections: 0,
      storageFailures: 0,
      broadcastFailures: 1,
      persisted: 5,
      broadcasts: 4,
    };

    expect(pipelineStageWarnings(base)).toEqual([]);
    expect(pipelineStageWarnings({ ...base, persisted: 4 })).toEqual([
      'Accepted activity is waiting for persistence.',
    ]);
    expect(pipelineStageWarnings({ ...base, broadcasts: 3 })).toEqual([
      'Persisted activity is waiting for broadcast.',
    ]);
  });
});
