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
