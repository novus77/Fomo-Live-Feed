import { describe, expect, it, vi } from 'vitest';

import { createContentTranslationClient } from '../../src/translation/content-translation-client';

describe('createContentTranslationClient', () => {
  it('creates a remote session and translates through the worker boundary', async () => {
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

    expect(sendMessage).toHaveBeenCalledTimes(3);
  });
});
