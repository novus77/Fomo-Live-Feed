import {
  parseExtensionMessage,
  PROTOCOL_VERSION,
  type ExtensionMessage,
} from '../messaging/protocol';
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

  const handleCommand = async (
    message: Extract<ExtensionMessage, { type: 'translation.request' }>,
  ): Promise<ContentTranslationReply> => {
    const command = message.payload;
    clientId = command.clientId;
    try {
      switch (command.command) {
        case 'statusQuery':
          return { ok: true, result: { available: (await service.availability('en', 'zh')) !== 'unavailable' } };
        case 'initialize':
        case 'create':
          return { ok: true, result: { sessionId: await service.create(command.sourceLanguage, command.targetLanguage, command.clientId) } };
        case 'detect':
          return { ok: true, result: await service.detect(command.text) };
        case 'availability':
          return { ok: true, result: await service.availability(command.sourceLanguage, command.targetLanguage) };
        case 'translate':
          return { ok: true, result: await service.translate(command.sessionId, command.text, command.clientId) };
        case 'destroy':
          service.destroy(command.sessionId, command.clientId);
          return { ok: true, result: null };
      }
    } catch (error) {
      return {
        ok: false,
        error: { code: error instanceof ContentTranslationServiceError ? error.code : 'translation-failed' },
      };
    }
  };
  const listener = (raw: unknown): Promise<ContentTranslationReply> | undefined => {
    const parsed = parseExtensionMessage(raw);
    if (!parsed.ok || parsed.message.type !== 'translation.request') return undefined;
    return handleCommand(parsed.message);
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
