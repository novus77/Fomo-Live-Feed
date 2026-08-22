import type { PopupRuntimeLike } from '../popup/popup-io';
import type {
  BrowserTranslationApi,
  ModelAvailability,
  TranslatorSession,
} from './browser-translation';
import {
  TranslationActivationRequiredError,
  TranslationApiUnavailableError,
  TranslationUnsupportedPairError,
} from './browser-translation';

type Reply = { ok: boolean; result?: unknown; error?: { code?: unknown } };

export function createContentTranslationClient(
  runtime: PopupRuntimeLike,
  clientId: string,
): BrowserTranslationApi {
  let sequence = 0;
  const request = async (command: Record<string, unknown>): Promise<unknown> => {
    const reply = (await runtime.sendMessage({
      protocolVersion: 1,
      type: 'translation.request',
      payload: { requestId: `${clientId}-${++sequence}`, clientId, ...command },
    })) as Reply | undefined;
    if (reply?.ok === true) return reply.result;
    throw mapError(reply?.error?.code);
  };

  return {
    async detect(text) {
      return request({ command: 'detect', text }) as Promise<{ language: string; confidence: number }>;
    },
    async availability(sourceLanguage, targetLanguage) {
      return request({ command: 'availability', sourceLanguage, targetLanguage }) as Promise<ModelAvailability>;
    },
    async create(sourceLanguage, targetLanguage) {
      const result = await request({ command: 'create', sourceLanguage, targetLanguage }) as { sessionId?: unknown };
      if (typeof result.sessionId !== 'string') throw new TranslationApiUnavailableError();
      const sessionId = result.sessionId;
      return {
        translate: async (text: string) => {
          const translated = await request({ command: 'translate', sessionId, text });
          if (typeof translated !== 'string') throw new TranslationApiUnavailableError();
          return translated;
        },
        destroy: () => {
          void request({ command: 'destroy', sessionId }).catch(() => {});
        },
      } satisfies TranslatorSession;
    },
  };
}

function mapError(code: unknown): Error {
  switch (code) {
    case 'activation-required':
      return new TranslationActivationRequiredError();
    case 'unsupported-pair':
      return new TranslationUnsupportedPairError();
    default:
      return new TranslationApiUnavailableError();
  }
}
