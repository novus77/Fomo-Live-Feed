import fixture from '../fixtures/pump/following-trades-page.json';
import { PumpPollingSession } from '../../src/pump/polling-session';
import { parsePumpTradePage, type RawPumpTrade } from '../../src/pump/raw-schema';

const base = parsePumpTradePage(fixture).accepted[0]!;
const item = (tx: string, timestamp: string): RawPumpTrade => ({
  ...base,
  createdAt: timestamp,
  trade: { ...base.trade, tx, timestamp },
});

const page = (items: RawPumpTrade[], nextCursor?: string) => ({
  accepted: items,
  rejectedCount: 0,
  ...(nextCursor !== undefined ? { nextCursor } : {}),
});

describe('PumpPollingSession', () => {
  it('uses the initial page only to establish a watermark', () => {
    const session = new PumpPollingSession({ startedAt: Date.parse('2026-09-09T02:00:10Z') });
    const result = session.acceptNewestPage(page([
      item('tx-2', '2026-09-09T02:00:02Z'),
      item('tx-1', '2026-09-09T02:00:01Z'),
    ]));

    expect(result).toEqual({ status: 'initial' });
    expect(session.snapshot().watermark).toBe('1399811149:tx-2');
  });

  it('emits the first trade that arrives after an empty initial page', () => {
    const session = new PumpPollingSession({ startedAt: Date.parse('2026-09-09T02:00:10Z') });

    expect(session.acceptNewestPage(page([]))).toEqual({ status: 'initial' });
    expect(session.acceptNewestPage(page([
      item('first-live', '2026-09-09T02:00:11Z'),
    ]))).toEqual({
      status: 'events',
      delivery: 'live',
      items: [item('first-live', '2026-09-09T02:00:11Z')],
    });
  });

  it('emits only post-watermark trades as live and oldest first', () => {
    const session = new PumpPollingSession({ startedAt: Date.parse('2026-09-09T02:00:10Z') });
    session.acceptNewestPage(page([item('old', '2026-09-09T02:00:01Z')]));

    const result = session.acceptNewestPage(page([
      item('new-2', '2026-09-09T02:00:03Z'),
      item('new-1', '2026-09-09T02:00:02Z'),
      item('old', '2026-09-09T02:00:01Z'),
    ]));

    expect(result.status).toBe('events');
    if (result.status === 'events') {
      expect(result.delivery).toBe('live');
      expect(result.items.map((entry) => entry.trade.tx)).toEqual(['new-1', 'new-2']);
    }
  });

  it('continues with cursors and emits recovered rows without duplicates', () => {
    const session = new PumpPollingSession({ startedAt: Date.parse('2026-09-09T02:00:10Z') });
    session.acceptNewestPage(page([item('old', '2026-09-09T02:00:01Z')]));

    expect(session.acceptNewestPage(page([
      item('new-3', '2026-09-09T02:00:04Z'),
      item('new-2', '2026-09-09T02:00:03Z'),
    ], 'cursor-1'))).toEqual({ status: 'catching-up', cursor: 'cursor-1' });

    const result = session.acceptCatchUpPage(page([
      item('new-2', '2026-09-09T02:00:03Z'),
      item('new-1', '2026-09-09T02:00:02Z'),
      item('old', '2026-09-09T02:00:01Z'),
    ], 'cursor-2'));

    expect(result.status).toBe('events');
    if (result.status === 'events') {
      expect(result.delivery).toBe('recovered');
      expect(result.items.map((entry) => entry.trade.tx)).toEqual(['new-1', 'new-2', 'new-3']);
    }
  });

  it('restores a bounded recent-key window', () => {
    const session = new PumpPollingSession({
      startedAt: Date.parse('2026-09-09T02:00:10Z'),
      seed: { watermark: '1399811149:old', recentKeys: ['1399811149:old'] },
    });

    expect(session.acceptNewestPage(page([item('old', '2026-09-09T02:00:01Z')]))).toEqual({
      status: 'events',
      delivery: 'live',
      items: [],
    });
  });
});
