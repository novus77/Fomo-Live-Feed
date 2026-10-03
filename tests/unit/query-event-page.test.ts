import { describe, expect, it, vi } from 'vitest';

import { queryEventPage, type PopupRuntimeLike } from '../../src/popup/popup-io';
import { parseExtensionMessage } from '../../src/messaging/protocol';

const cursor = { beforeOccurredAt: 100, beforeId: 'fomo:last-scanned' };
const runtimeFor = (response: unknown): PopupRuntimeLike => ({
  sendMessage: vi.fn(async () => response),
  onMessage: { addListener() {}, removeListener() {} },
});

describe('queryEventPage', () => {
  it('opts into progress and preserves an empty resumable page', async () => {
    const page = { cursor, scannedRows: 500, hasMore: true, scanExceeded: true };
    const runtime = runtimeFor({ ok: true, events: [], page });
    expect(await queryEventPage(runtime, { limit: 50, unreadOnly: true })).toEqual({ events: [], ...page });
    const sent = vi.mocked(runtime.sendMessage).mock.calls[0]![0];
    expect(sent).toMatchObject({ type: 'events.query', payload: { includeScanProgress: true, unreadOnly: true } });
    expect(parseExtensionMessage(sent).ok).toBe(true);
  });

  it('retains legacy array replies from injected query clients', async () => {
    expect(await queryEventPage(runtimeFor({ ok: true, events: [] }), { limit: 50 })).toEqual([]);
  });

  it('drops malformed rows without losing the last examined cursor', async () => {
    const runtime = runtimeFor({ ok: true, events: [{ schemaVersion: 2 }], page: {
      cursor, scannedRows: 1, hasMore: true, scanExceeded: false,
    } });
    expect(await queryEventPage(runtime, { limit: 1 })).toMatchObject({ events: [], cursor, hasMore: true });
    expect(runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'diagnostics.record' }));
  });

  it.each([
    { cursor: null, scannedRows: 500, hasMore: true, scanExceeded: true },
    { cursor, scannedRows: 500, hasMore: false, scanExceeded: true },
    { cursor, scannedRows: -1, hasMore: false, scanExceeded: false },
    { cursor: { ...cursor, beforeOccurredAt: NaN }, scannedRows: 1, hasMore: true, scanExceeded: false },
  ])('rejects malformed explicit progress: %j', async (page) => {
    await expect(queryEventPage(runtimeFor({ ok: true, events: [], page }), { limit: 50 })).rejects.toThrow('invalid scan progress');
  });
});
