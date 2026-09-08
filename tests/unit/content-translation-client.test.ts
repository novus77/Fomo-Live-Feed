import { describe, expect, it, vi } from 'vitest';

import { createContentTranslationClient } from '../../src/translation/content-translation-client';
import { TranslationContextDisposedError } from '../../src/translation/browser-translation';

describe('createContentTranslationClient', () => {
  it('creates a content-host session and translates through the worker boundary', async () => {
    const sendMessage = vi.fn(async (message: { payload: { command: string } }) => {
      if (message.payload.command === 'create') {
        return { ok: true, result: { sessionId: 'en:zh' } };
      }
      if (message.payload.command === 'translate') {
        return { ok: true, result: '中文观点' };
      }
      return { ok: true, result: null };
    });
    const client = createContentTranslationClient({
      sendMessage,
      onMessage: { addListener: () => {}, removeListener: () => {} },
    }, 'panel-1');

    const session = await client.create('en', 'zh');
    await expect(session.translate('English opinion')).resolves.toBe('中文观点');
    session.destroy();

    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(3));
  });

  it('destroys each remote wrapper at most once', async () => {
    const sendMessage = vi.fn(async (message: { payload: { command: string } }) => (
      message.payload.command === 'create'
        ? { ok: true, result: { sessionId: 'host-session-1' } }
        : { ok: true, result: null }
    ));
    const client = createContentTranslationClient({
      sendMessage,
      onMessage: { addListener: () => {}, removeListener: () => {} },
    }, 'panel-1');

    const session = await client.create('en', 'zh');
    session.destroy();
    session.destroy();

    await vi.waitFor(() => {
      expect(sendMessage.mock.calls.filter(
        ([message]) => message.payload.command === 'destroy',
      )).toHaveLength(1);
    });
  });

  it('preserves a disposed content context as a recoverable session error', async () => {
    const sendMessage = vi.fn(async (message: { payload: { command: string } }) => {
      if (message.payload.command === 'create') {
        return { ok: true, result: { sessionId: 'fomo-tab:1:en:zh' } };
      }
      return { ok: false, error: { code: 'context-disposed' } };
    });
    const client = createContentTranslationClient({
      sendMessage,
      onMessage: { addListener: () => {}, removeListener: () => {} },
    }, 'panel-1');

    const session = await client.create('en', 'zh');
    await expect(session.translate('English opinion')).rejects.toBeInstanceOf(
      TranslationContextDisposedError,
    );
  });
});
