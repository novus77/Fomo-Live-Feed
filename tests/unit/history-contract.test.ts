import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_HISTORY_LIMIT,
  FOMO_HISTORY_ENDPOINT,
  MAX_HISTORY_CURSOR_LENGTH,
  MAX_HISTORY_LIMIT,
  MAX_HISTORY_PAGE_SIZE,
  buildHistoryUrl,
  historyQuerySchema,
  parseHistoryPage,
} from '../../src/fomo/history-contract';

// The redacted fixture preserves the envelope and replaces every identity,
// address, amount, timestamp, URL, and prose value (docs/evidence/
// fomo-history-contract.md). The top-level `note` and `captureIntegrity` keys
// are fixture annotations, NOT part of the API envelope.
const FIXTURE_PATH = 'tests/fixtures/fomo-history-page.redacted.json';

const readFixture = (): unknown =>
  JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as unknown;

describe('parseHistoryPage', () => {
  it('parses the redacted fixture envelope and every activity payload', () => {
    const page = parseHistoryPage(readFixture());

    expect(page).toBeDefined();
    expect(page?.activities).toHaveLength(4);
    expect(page?.nextCursor).toBe('SYNTHETIC-CURSOR-PLACEHOLDER-0001');
    // hasMore: true with a real cursor -> not terminal.
    expect(page?.complete).toBe(false);
  });

  it('tolerates the fixture annotations but never carries them in the result', () => {
    const page = parseHistoryPage(readFixture());

    expect(page).toBeDefined();
    expect(JSON.stringify(page)).not.toContain('captureIntegrity');
    expect(JSON.stringify(page)).not.toContain('"note"');
    expect(JSON.stringify(page)).not.toContain('sha256-redacted-outside-git');
    // Activity payloads themselves are carried verbatim (normalizeActivity
    // re-validates them later), but only the closed envelope fields survive.
    expect(Object.keys(page ?? {})).toEqual(['activities', 'nextCursor', 'complete']);
  });

  it('marks the page terminal when nextCursor is null or absent, or hasMore is false', () => {
    const fixture = readFixture() as {
      responseObject: { activities: unknown[]; nextCursor?: string | null; hasMore?: boolean };
    };
    const activities = fixture.responseObject.activities;

    expect(parseHistoryPage({ responseObject: { activities, nextCursor: null, hasMore: true } })?.complete).toBe(true);
    expect(parseHistoryPage({ responseObject: { activities, hasMore: false } })?.complete).toBe(true);
    expect(parseHistoryPage({ responseObject: { activities } })?.complete).toBe(true);
    expect(
      parseHistoryPage({ responseObject: { activities, nextCursor: 'cursor-1', hasMore: true } })?.complete,
    ).toBe(false);
  });

  it('rejects malformed envelopes without throwing', () => {
    for (const body of [
      null,
      undefined,
      'text',
      42,
      [],
      {},
      { responseObject: null },
      { responseObject: {} },
      { responseObject: { activities: 'not-an-array' } },
      { responseObject: { activities: [{}] } },
      { responseObject: { activities: [{ id: 'x' }] } },
      { responseObject: { activities: [], nextCursor: 42 } },
      { responseObject: { activities: [], nextCursor: '' } },
      { responseObject: { activities: [], hasMore: 'yes' } },
      { responseObject: { activities: [], nextCursor: 'x', smuggled: 'secret' } },
    ]) {
      expect(parseHistoryPage(body)).toBeUndefined();
    }
  });

  it('rejects an activity payload that fails the shared raw schema', () => {
    const fixture = readFixture() as { responseObject: { activities: unknown[] } };
    const activities = fixture.responseObject.activities;

    const withoutUserId = structuredClone(activities[0]);
    delete (withoutUserId as Record<string, unknown>).userId;
    expect(parseHistoryPage({ responseObject: { activities: [withoutUserId] } })).toBeUndefined();

    const badTimestamp = structuredClone(activities[0]);
    (badTimestamp as Record<string, unknown>).createdAt = 'not-a-timestamp';
    expect(parseHistoryPage({ responseObject: { activities: [badTimestamp] } })).toBeUndefined();
  });

  it('caps the page at 200 activities and rejects a larger page', () => {
    const fixture = readFixture() as { responseObject: { activities: unknown[] } };
    const one = fixture.responseObject.activities[0];

    const atCap = Array.from({ length: MAX_HISTORY_PAGE_SIZE }, () => structuredClone(one));
    expect(parseHistoryPage({ responseObject: { activities: atCap } })).toBeDefined();

    const overCap = Array.from({ length: MAX_HISTORY_PAGE_SIZE + 1 }, () => structuredClone(one));
    expect(parseHistoryPage({ responseObject: { activities: overCap } })).toBeUndefined();
  });

  it('bounds the response cursor at 512 non-empty characters', () => {
    const fixture = readFixture() as { responseObject: { activities: unknown[] } };
    const activities = fixture.responseObject.activities;

    expect(
      parseHistoryPage({ responseObject: { activities, nextCursor: 'c'.repeat(MAX_HISTORY_CURSOR_LENGTH) } }),
    ).toBeDefined();
    expect(
      parseHistoryPage({ responseObject: { activities, nextCursor: 'c'.repeat(MAX_HISTORY_CURSOR_LENGTH + 1) } }),
    ).toBeUndefined();
    expect(parseHistoryPage({ responseObject: { activities, nextCursor: '   ' } })).toBeUndefined();
  });

  it('rejects hostile extra keys inside the strict response envelope', () => {
    const fixture = readFixture() as { responseObject: { activities: unknown[] } };
    const activities = fixture.responseObject.activities;

    expect(
      parseHistoryPage({
        responseObject: { activities, cookie: 'secret', headers: {}, url: 'https://evil.example' },
      }),
    ).toBeUndefined();
  });
});

describe('historyQuerySchema (request bounds)', () => {
  it('accepts a limit in [1, 200] and rejects everything else', () => {
    for (const limit of [1, 50, MAX_HISTORY_LIMIT]) {
      expect(historyQuerySchema.safeParse({ limit }).success).toBe(true);
    }
    for (const limit of [0, -1, 1.5, MAX_HISTORY_LIMIT + 1, '50']) {
      expect(historyQuerySchema.safeParse({ limit }).success).toBe(false);
    }
    expect(historyQuerySchema.safeParse({}).success).toBe(true);
  });

  it('accepts an omitted or empty cursor and bounds a present one at 512 chars', () => {
    expect(historyQuerySchema.safeParse({}).success).toBe(true);
    expect(historyQuerySchema.safeParse({ cursor: '' }).success).toBe(true);
    expect(historyQuerySchema.safeParse({ cursor: 'c'.repeat(MAX_HISTORY_CURSOR_LENGTH) }).success).toBe(true);
    expect(historyQuerySchema.safeParse({ cursor: 'c'.repeat(MAX_HISTORY_CURSOR_LENGTH + 1) }).success).toBe(false);
    expect(historyQuerySchema.safeParse({ cursor: 42 }).success).toBe(false);
    expect(historyQuerySchema.safeParse({ cursor: 'x', extra: 1 }).success).toBe(false);
  });
});

describe('buildHistoryUrl', () => {
  it('builds the fixed endpoint with a default limit and no cursor on the first page', () => {
    const url = buildHistoryUrl({});

    expect(url.origin + url.pathname).toBe(FOMO_HISTORY_ENDPOINT);
    expect(url.searchParams.get('limit')).toBe(String(DEFAULT_HISTORY_LIMIT));
    expect(url.searchParams.has('cursor')).toBe(false);
  });

  it('includes an explicit limit and a non-empty cursor', () => {
    const url = buildHistoryUrl({ limit: 200, cursor: 'cursor-abc' });

    expect(url.searchParams.get('limit')).toBe('200');
    expect(url.searchParams.get('cursor')).toBe('cursor-abc');
  });

  it('omits an empty cursor (contract: omitted or empty on the first page)', () => {
    const url = buildHistoryUrl({ cursor: '' });

    expect(url.searchParams.has('cursor')).toBe(false);
  });
});
