import { describe, expect, it, vi } from 'vitest';

import {
  ContentTranslationService,
} from '../../src/translation/content-translation-service';

function activationError(): Error {
  const error = new Error('activation required');
  error.name = 'NotAllowedError';
  return error;
}

describe('ContentTranslationService', () => {
  it('accepts a function-valued Translator with static methods', async () => {
    const session = {
      translate: vi.fn(async () => '你好，世界！'),
      destroy: vi.fn(),
    };
    class Translator {
      static availability = vi.fn(async () => 'available');
      static create = vi.fn(async () => session);
    }
    const service = new ContentTranslationService({ env: { Translator } });

    await expect(service.availability('en', 'zh')).resolves.toBe('available');
    const id = await service.create('en', 'zh');
    await expect(service.translate(id, 'Hello, world!')).resolves.toBe('你好，世界！');
    expect(Translator.create).toHaveBeenCalledWith({ sourceLanguage: 'en', targetLanguage: 'zh' });
    service.destroy(id);
    expect(session.destroy).toHaveBeenCalledOnce();
  });

  it.each([null, undefined, 1, 'invalid', () => {}, { create: true }])(
    'rejects an invalid Translator: %s',
    async (Translator) => {
      const service = new ContentTranslationService({ env: { Translator } });
      await expect(service.availability('en', 'zh')).resolves.toBe('unavailable');
      await expect(service.create('en', 'zh')).rejects.toMatchObject({ code: 'api-unavailable' });
    },
  );

  it('retries a pending language pair once after a trusted Fomo-page gesture', async () => {
    const ready = vi.fn();
    const create = vi
      .fn()
      .mockRejectedValueOnce(activationError())
      .mockResolvedValueOnce({
        translate: async (text: string) => `translated:${text}`,
        destroy: vi.fn(),
      });
    const service = new ContentTranslationService({
      env: {
        Translator: {
          availability: vi.fn(async () => 'downloadable'),
          create,
        },
      },
      onReady: ready,
    });

    await expect(service.create('en', 'zh')).rejects.toMatchObject({
      code: 'activation-required',
    });

    service.handleTrustedGesture();
    await vi.waitFor(() => expect(ready).toHaveBeenCalledWith({
      sourceLanguage: 'en',
      targetLanguage: 'zh',
    }));
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent creation for the same language pair', async () => {
    let release!: (session: { translate(text: string): Promise<string>; destroy(): void }) => void;
    const create = vi.fn(
      () => new Promise<{ translate(text: string): Promise<string>; destroy(): void }>((resolve) => {
        release = resolve;
      }),
    );
    const service = new ContentTranslationService({
      env: { Translator: { availability: vi.fn(async () => 'available'), create } },
    });

    const first = service.create('en', 'zh');
    const second = service.create('en', 'zh');
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    release({ translate: async (text) => text, destroy: vi.fn() });

    await expect(Promise.all([first, second])).resolves.toEqual(['en:zh', 'en:zh']);
    expect(create).toHaveBeenCalledOnce();
  });
});
