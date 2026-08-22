import { parseExtensionMessage, PROTOCOL_VERSION } from '../messaging/protocol';
import { readBrowserTranslationEnv } from './browser-translation';
import {
  ContentTranslationService,
  ContentTranslationServiceError,
} from './content-translation-service';

export interface ContentTranslationRuntime {
  onMessage: {
    addListener(listener: (message: unknown) => unknown): void;
    removeListener(listener: (message: unknown) => unknown): void;
  };
  sendMessage(message: unknown): Promise<unknown>;
}

export interface ContentTranslationReply {
  ok: boolean;
  result?: unknown;
  error?: { code: string };
}

/** Installs the translation command endpoint inside the isolated Fomo world. */
export function installContentTranslationHost(runtime: ContentTranslationRuntime) {
  let clientId: string | undefined;
  const service = new ContentTranslationService({
    env: readBrowserTranslationEnv(),
    readEnv: readBrowserTranslationEnv,
    onReady: ({ sourceLanguage, targetLanguage }) => {
      if (clientId === undefined) return;
      void runtime.sendMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'translation.ready',
        payload: { clientId, sourceLanguage, targetLanguage },
      }).catch(() => {});
    },
  });

  const listener = async (raw: unknown): Promise<ContentTranslationReply | undefined> => {
    const parsed = parseExtensionMessage(raw);
    if (!parsed.ok || parsed.message.type !== 'translation.request') return undefined;
    const command = parsed.message.payload;
    clientId = command.clientId;
    try {
      switch (command.command) {
        case 'statusQuery':
          return { ok: true, result: { available: (await service.availability('en', 'zh')) !== 'unavailable' } };
        case 'initialize':
        case 'create':
          return { ok: true, result: { sessionId: await service.create(command.sourceLanguage, command.targetLanguage) } };
        case 'detect':
          return { ok: true, result: await service.detect(command.text) };
        case 'availability':
          return { ok: true, result: await service.availability(command.sourceLanguage, command.targetLanguage) };
        case 'translate':
          return { ok: true, result: await service.translate(command.sessionId, command.text) };
        case 'destroy':
          service.destroy(command.sessionId);
          return { ok: true, result: null };
      }
    } catch (error) {
      return {
        ok: false,
        error: { code: error instanceof ContentTranslationServiceError ? error.code : 'translation-failed' },
      };
    }
  };

  const gesture = (): void => service.handleTrustedGesture();
  runtime.onMessage.addListener(listener);
  document.addEventListener('pointerdown', gesture, true);
  document.addEventListener('keydown', gesture, true);
  void runtime.sendMessage({
    protocolVersion: PROTOCOL_VERSION,
    type: 'translation.hostReady',
  }).catch(() => {});

  return {
    uninstall(): void {
      runtime.onMessage.removeListener(listener);
      document.removeEventListener('pointerdown', gesture, true);
      document.removeEventListener('keydown', gesture, true);
      service.dispose();
    },
  };
}
