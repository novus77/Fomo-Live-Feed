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

  it('does not lose a trusted gesture to an older automatic create retry', async () => {
    let rejectAutomaticRetry!: (error: Error) => void;
    const translatedSession = {
      translate: vi.fn(async (text: string) => `translated:${text}`),
      destroy: vi.fn(),
    };
    const create = vi
      .fn()
      .mockRejectedValueOnce(activationError())
      .mockImplementationOnce(() => new Promise((_, reject) => {
        rejectAutomaticRetry = reject;
      }))
      .mockResolvedValueOnce(translatedSession);
    const ready = vi.fn();
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
    const automaticRetry = service.create('en', 'zh');
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));

    service.handleTrustedGesture();
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(ready).toHaveBeenCalledWith({
      sourceLanguage: 'en',
      targetLanguage: 'zh',
    }));

    rejectAutomaticRetry(activationError());
    const replacementId = await automaticRetry;
    await expect(service.translate(replacementId, 'Hello')).resolves.toBe('translated:Hello');
  });

  it('destroys an older create that resolves after a trusted-gesture replacement', async () => {
    let resolveAutomaticRetry!: (session: {
      translate(text: string): Promise<string>;
      destroy(): void;
    }) => void;
    const staleSession = {
      translate: vi.fn(async () => 'stale'),
      destroy: vi.fn(),
    };
    const gestureSession = {
      translate: vi.fn(async (text: string) => `gesture:${text}`),
      destroy: vi.fn(),
    };
    const create = vi
      .fn()
      .mockRejectedValueOnce(activationError())
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveAutomaticRetry = resolve;
      }))
      .mockResolvedValueOnce(gestureSession);
    const ready = vi.fn();
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
    const automaticRetry = service.create('en', 'zh');
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    service.handleTrustedGesture();
    await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());

    resolveAutomaticRetry(staleSession);
    const replacementId = await automaticRetry;
    expect(staleSession.destroy).toHaveBeenCalledOnce();
    await expect(service.translate(replacementId, 'Hello')).resolves.toBe('gesture:Hello');
  });

  it('invalidates and destroys a create that resolves after dispose', async () => {
    let resolveCreate!: (session: {
      translate(text: string): Promise<string>;
      destroy(): void;
    }) => void;
    const lateSession = {
      translate: vi.fn(async () => 'late'),
      destroy: vi.fn(),
    };
    const service = new ContentTranslationService({
      env: {
        Translator: {
          availability: vi.fn(async () => 'available'),
          create: vi.fn(() => new Promise((resolve) => {
            resolveCreate = resolve;
          })),
        },
      },
    });

    const creating = service.create('en', 'zh');
    await vi.waitFor(() => expect(resolveCreate).toBeTypeOf('function'));
    service.dispose();
    resolveCreate(lateSession);

    await expect(creating).rejects.toMatchObject({ code: 'context-disposed' });
    expect(lateSession.destroy).toHaveBeenCalledOnce();
    await expect(service.translate('missing-session', 'Hello')).rejects.toMatchObject({
      code: 'context-disposed',
    });
  });

  it('does not let a stale session id destroy its replacement', async () => {
    const firstSession = {
      translate: vi.fn(async (text: string) => `first:${text}`),
      destroy: vi.fn(),
    };
    const replacementSession = {
      translate: vi.fn(async (text: string) => `replacement:${text}`),
      destroy: vi.fn(),
    };
    const create = vi.fn()
      .mockResolvedValueOnce(firstSession)
      .mockResolvedValueOnce(replacementSession);
    const service = new ContentTranslationService({
      env: { Translator: { availability: vi.fn(async () => 'available'), create } },
    });

    const firstId = await service.create('en', 'zh');
    service.destroy(firstId);
    const replacementId = await service.create('en', 'zh');

    expect(replacementId).not.toBe(firstId);
    service.destroy(firstId);
    expect(replacementSession.destroy).not.toHaveBeenCalled();
    await expect(service.translate(replacementId, 'Hello')).resolves.toBe('replacement:Hello');
    await expect(service.translate(firstId, 'Hello')).rejects.toMatchObject({
      code: 'context-disposed',
    });
  });

  it('destroys a trusted-gesture create that resolves after dispose without reporting ready', async () => {
    let resolveGestureCreate!: (session: {
      translate(text: string): Promise<string>;
      destroy(): void;
    }) => void;
    const lateSession = {
      translate: vi.fn(async () => 'late'),
      destroy: vi.fn(),
    };
    const create = vi
      .fn()
      .mockRejectedValueOnce(activationError())
      .mockImplementationOnce(() => new Promise((resolve) => {
        resolveGestureCreate = resolve;
      }));
    const ready = vi.fn();
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
    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(2));
    service.dispose();
    resolveGestureCreate(lateSession);

    await vi.waitFor(() => expect(lateSession.destroy).toHaveBeenCalledOnce());
    expect(ready).not.toHaveBeenCalled();
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

    const [firstId, secondId] = await Promise.all([first, second]);
    expect(firstId).toBe(secondId);
    expect(create).toHaveBeenCalledOnce();
  });
});
