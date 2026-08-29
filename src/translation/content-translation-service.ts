import type { BrowserTranslationEnv, TranslatorSession } from './browser-translation';
import { inferCommonOpinionLanguage } from './local-language-hint';

export class ContentTranslationServiceError extends Error {
  readonly code: 'activation-required' | 'api-unavailable' | 'unsupported-pair' | 'context-disposed' | 'translation-failed';

  constructor(code: ContentTranslationServiceError['code']) {
    super(code);
    this.name = 'ContentTranslationServiceError';
    this.code = code;
  }
}

interface TranslatorLike {
  availability?(options: { sourceLanguage: string; targetLanguage: string }): Promise<unknown>;
  create(options: { sourceLanguage: string; targetLanguage: string }): Promise<TranslatorSession>;
}

export interface ContentTranslationServiceDependencies {
  env: BrowserTranslationEnv;
  /**
   * Read browser globals at command time. Content scripts may start before
   * Chrome exposes an optional built-in AI API, so a startup snapshot is not
   * a reliable capability decision.
   */
  readEnv?(): BrowserTranslationEnv;
  onReady?(pair: { sourceLanguage: string; targetLanguage: string }): void;
}

/**
 * Owns Chrome built-in translation sessions in the isolated Fomo document.
 * Pending activation keeps only a language pair, never the opinion text.
 */
export class ContentTranslationService {
  private readonly initialEnv: BrowserTranslationEnv;
  private readonly readEnv: (() => BrowserTranslationEnv) | undefined;
  private readonly onReady: ((pair: { sourceLanguage: string; targetLanguage: string }) => void) | undefined;
  private readonly sessions = new Map<string, TranslatorSession>();
  private readonly creates = new Map<string, Promise<string>>();
  private readonly pendingActivation = new Set<string>();

  constructor(deps: ContentTranslationServiceDependencies) {
    this.initialEnv = deps.env;
    this.readEnv = deps.readEnv;
    this.onReady = deps.onReady;
  }

  async create(sourceLanguage: string, targetLanguage: string): Promise<string> {
    const key = `${sourceLanguage}:${targetLanguage}`;
    if (this.sessions.has(key)) return key;
    const inFlight = this.creates.get(key);
    if (inFlight !== undefined) return inFlight;

    const creating = this.createPair(key, sourceLanguage, targetLanguage);
    this.creates.set(key, creating);
    try {
      return await creating;
    } finally {
      this.creates.delete(key);
    }
  }

  async translate(sessionId: string, text: string): Promise<string> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) {
      throw new ContentTranslationServiceError('context-disposed');
    }
    try {
      return await session.translate(text);
    } catch {
      throw new ContentTranslationServiceError('translation-failed');
    }
  }

  async detect(text: string): Promise<{ language: string; confidence: number }> {
    return { language: inferCommonOpinionLanguage(text) ?? 'en', confidence: 1 };
  }

  async availability(sourceLanguage: string, targetLanguage: string): Promise<string> {
    const translator = this.getTranslator();
    if (translator === undefined) return 'unavailable';
    return (await translator.availability?.({ sourceLanguage, targetLanguage })) === 'unavailable'
      ? 'unavailable'
      : 'available';
  }

  destroy(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;
    this.sessions.delete(sessionId);
    session.destroy();
  }

  handleTrustedGesture(): void {
    for (const key of [...this.pendingActivation]) {
      this.pendingActivation.delete(key);
      const [sourceLanguage, targetLanguage] = key.split(':');
      if (sourceLanguage === undefined || targetLanguage === undefined) continue;
      void this.create(sourceLanguage, targetLanguage)
        .then(() => this.onReady?.({ sourceLanguage, targetLanguage }))
        .catch(() => {});
    }
  }

  dispose(): void {
    this.pendingActivation.clear();
    this.creates.clear();
    for (const session of this.sessions.values()) {
      session.destroy();
    }
    this.sessions.clear();
  }

  private async createPair(
    key: string,
    sourceLanguage: string,
    targetLanguage: string,
  ): Promise<string> {
    const translator = this.getTranslator();
    if (translator === undefined) {
      throw new ContentTranslationServiceError('api-unavailable');
    }
    try {
      const availability = await translator.availability?.({ sourceLanguage, targetLanguage });
      if (availability === 'unavailable') {
        throw new ContentTranslationServiceError('unsupported-pair');
      }
      const session = await translator.create({ sourceLanguage, targetLanguage });
      this.sessions.set(key, session);
      return key;
    } catch (error) {
      if (error instanceof ContentTranslationServiceError) throw error;
      if (isNamedError(error, 'NotAllowedError') || isNamedError(error, 'InvalidStateError')) {
        this.pendingActivation.add(key);
        throw new ContentTranslationServiceError('activation-required');
      }
      if (isNamedError(error, 'NotSupportedError')) {
        throw new ContentTranslationServiceError('unsupported-pair');
      }
      throw new ContentTranslationServiceError('translation-failed');
    }
  }

  private getTranslator(): TranslatorLike | undefined {
    const candidate = (this.readEnv?.() ?? this.initialEnv).Translator;
    // Native Chrome APIs are constructors; object adapters remain supported.
    return (typeof candidate === 'function' || typeof candidate === 'object') && candidate !== null &&
      typeof (candidate as TranslatorLike).create === 'function'
      ? (candidate as TranslatorLike)
      : undefined;
  }
}

function isNamedError(error: unknown, name: string): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === name;
}
