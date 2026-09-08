import { describe, expect, it, vi } from 'vitest';

import { TranslationActivationRequiredError } from '../../src/translation/browser-translation';
import { createContentTranslationClient } from '../../src/translation/content-translation-client';
import { installContentTranslationHost } from '../../src/translation/content-translation-host';
import { OpinionTranslationCoordinator } from '../../src/translation/opinion-translation';

describe('installContentTranslationHost', () => {
  it('does not claim non-translation messages from sibling content listeners', () => {
    let listener: ((message: unknown) => unknown) | undefined;
    const runtime = {
      onMessage: {
        addListener(next: (message: unknown) => unknown) { listener = next; },
        removeListener() {},
      },
      sendMessage: vi.fn(async () => undefined),
    };
    const host = installContentTranslationHost(runtime);

    const response = listener?.({
      protocolVersion: 1,
      type: 'capture.ping',
    });

    expect(response).toBeUndefined();
    host.uninstall();
  });

  it('lets a ready retry join a superseded create after trusted activation', async () => {
    let hostListener: ((message: unknown) => unknown) | undefined;
    let rejectAutomaticRetry!: (error: Error) => void;
    const activationError = (): Error => {
      const error = new Error('activation required');
      error.name = 'InvalidStateError';
      return error;
    };
    const nativeSession = {
      translate: vi.fn(async () => '中文观点'),
      destroy: vi.fn(),
    };
    const translator = {
      availability: vi.fn(async () => 'downloadable'),
      create: vi
        .fn()
        .mockRejectedValueOnce(activationError())
        .mockImplementationOnce(() => new Promise((_, reject) => {
          rejectAutomaticRetry = reject;
        }))
        .mockResolvedValueOnce(nativeSession),
    };
    vi.stubGlobal('Translator', translator);
    const outbound: unknown[] = [];
    const host = installContentTranslationHost({
      onMessage: {
        addListener(listener) { hostListener = listener; },
        removeListener(listener) {
          if (hostListener === listener) hostListener = undefined;
        },
      },
      async sendMessage(message) {
        outbound.push(message);
        return undefined;
      },
    });
    const client = createContentTranslationClient({
      async sendMessage(message) {
        return hostListener?.(message);
      },
      onMessage: { addListener() {}, removeListener() {} },
    }, 'panel-1');
    const coordinator = new OpinionTranslationCoordinator({
      api: client,
      browserLanguage: () => 'zh-CN',
    });

    try {
      await expect(client.create('en', 'zh')).rejects.toBeInstanceOf(
        TranslationActivationRequiredError,
      );
      const first = coordinator.translate('English opinion');
      await vi.waitFor(() => expect(translator.create).toHaveBeenCalledTimes(2));

      document.dispatchEvent(new Event('pointerdown'));
      await vi.waitFor(() => expect(outbound).toContainEqual({
        protocolVersion: 1,
        type: 'translation.ready',
        payload: {
          clientId: 'panel-1',
          sourceLanguage: 'en',
          targetLanguage: 'zh',
        },
      }));
      const retryFromReady = coordinator.translate('English opinion');
      rejectAutomaticRetry(activationError());

      await expect(Promise.all([first, retryFromReady])).resolves.toEqual([
        { status: 'translated', original: 'English opinion', translated: '中文观点' },
        { status: 'translated', original: 'English opinion', translated: '中文观点' },
      ]);
      expect(nativeSession.translate).toHaveBeenCalledOnce();
    } finally {
      coordinator.destroy();
      host.uninstall();
      vi.unstubAllGlobals();
    }
  });

  it('keeps a replacement session alive when two texts observe the old context disposal', async () => {
    let hostListener: ((message: unknown) => unknown) | undefined;
    const firstNativeSession = {
      translate: vi.fn(async () => 'old'),
      destroy: vi.fn(),
    };
    const replacementNativeSession = {
      translate: vi.fn(async (text: string) => `replacement:${text}`),
      destroy: vi.fn(),
    };
    const translator = {
      availability: vi.fn(async () => 'available'),
      create: vi.fn()
        .mockResolvedValueOnce(firstNativeSession)
        .mockResolvedValueOnce(replacementNativeSession),
    };
    vi.stubGlobal('Translator', translator);
    const host = installContentTranslationHost({
      onMessage: {
        addListener(listener) { hostListener = listener; },
        removeListener(listener) {
          if (hostListener === listener) hostListener = undefined;
        },
      },
      async sendMessage() { return undefined; },
    });
    let firstSessionId: string | undefined;
    const disposeReplies = new Map<string, () => void>();
    const destroyedSessionIds: string[] = [];
    const client = createContentTranslationClient({
      async sendMessage(message) {
        const request = message as {
          payload: { command: string; sessionId?: string; text?: string };
        };
        if (
          request.payload.command === 'translate'
          && request.payload.sessionId === firstSessionId
          && request.payload.text !== undefined
        ) {
          return new Promise((resolve) => {
            disposeReplies.set(request.payload.text!, () => resolve({
              ok: false,
              error: { code: 'context-disposed' },
            }));
          });
        }
        if (request.payload.command === 'destroy' && request.payload.sessionId !== undefined) {
          destroyedSessionIds.push(request.payload.sessionId);
        }
        const reply = await hostListener?.(message);
        if (request.payload.command === 'create' && firstSessionId === undefined) {
          firstSessionId = (reply as { result?: { sessionId?: string } })?.result?.sessionId;
        }
        return reply;
      },
      onMessage: { addListener() {}, removeListener() {} },
    }, 'panel-1');
    const coordinator = new OpinionTranslationCoordinator({
      api: client,
      browserLanguage: () => 'zh-CN',
    });

    try {
      const first = coordinator.translate('First English opinion');
      const second = coordinator.translate('Second English opinion');
      await vi.waitFor(() => expect(disposeReplies.size).toBe(2));

      disposeReplies.get('First English opinion')?.();
      await vi.waitFor(() => expect(translator.create).toHaveBeenCalledTimes(2));
      disposeReplies.get('Second English opinion')?.();

      await expect(Promise.all([first, second])).resolves.toEqual([
        {
          status: 'translated',
          original: 'First English opinion',
          translated: 'replacement:First English opinion',
        },
        {
          status: 'translated',
          original: 'Second English opinion',
          translated: 'replacement:Second English opinion',
        },
      ]);
      expect(destroyedSessionIds).toEqual([firstSessionId]);
      expect(firstNativeSession.destroy).toHaveBeenCalledOnce();
      expect(replacementNativeSession.destroy).not.toHaveBeenCalled();
    } finally {
      coordinator.destroy();
      host.uninstall();
      vi.unstubAllGlobals();
    }
  });
});
