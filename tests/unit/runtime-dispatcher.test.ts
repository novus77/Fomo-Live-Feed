import { describe, expect, it, vi } from 'vitest';

import { createRuntimeMessageDispatcher } from '../../src/messaging/runtime-dispatcher';

describe('createRuntimeMessageDispatcher', () => {
  it('keeps Chrome’s response channel open for an asynchronous handled request', async () => {
    const handler = vi.fn(async (message: unknown) => ({ ok: true, message }));
    const sendResponse = vi.fn();
    const listener = createRuntimeMessageDispatcher(handler);

    expect(listener({ type: 'events.query' }, { id: 'extension' }, sendResponse)).toBe(true);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        ok: true,
        message: { type: 'events.query' },
      });
    });
  });

  it('does not claim the response channel for a message the handler rejects', () => {
    const handler = vi.fn(() => undefined);
    const sendResponse = vi.fn();
    const listener = createRuntimeMessageDispatcher(handler);

    expect(listener({ type: 'unknown' }, { id: 'extension' }, sendResponse)).toBeUndefined();
    expect(sendResponse).not.toHaveBeenCalled();
  });

  it('returns a stable serializable failure when a handled request rejects', async () => {
    const handler = vi.fn(async () => {
      throw new Error('storage exploded');
    });
    const sendResponse = vi.fn();
    const listener = createRuntimeMessageDispatcher(handler);

    expect(listener({ type: 'events.query' }, { id: 'extension' }, sendResponse)).toBe(true);

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({
        ok: false,
        error: 'request-failed',
      });
    });
  });
});
