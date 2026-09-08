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

interface ActiveSession {
  id: string;
  session: TranslatorSession;
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
  /** Current native session for each language pair. */
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly creates = new Map<string, Promise<string>>();
  private readonly createTokens = new Map<string, symbol>();
  private readonly pendingActivation = new Set<string>();
  /** Prevents a stale wrapper from addressing a newer session after reload. */
  private readonly sessionNamespace = crypto.randomUUID();
  private sessionSequence = 0;
  private disposed = false;

  constructor(deps: ContentTranslationServiceDependencies) {
    this.initialEnv = deps.env;
    this.readEnv = deps.readEnv;
    this.onReady = deps.onReady;
  }

  async create(sourceLanguage: string, targetLanguage: string): Promise<string> {
    if (this.disposed) throw new ContentTranslationServiceError('context-disposed');
    const key = `${sourceLanguage}:${targetLanguage}`;
    const active = this.sessions.get(key);
    if (active !== undefined) return active.id;
    const inFlight = this.creates.get(key);
    if (inFlight !== undefined) return inFlight;
    return this.beginCreate(key, sourceLanguage, targetLanguage);
  }

  async translate(sessionId: string, text: string): Promise<string> {
    const active = [...this.sessions.values()].find(({ id }) => id === sessionId);
    if (active === undefined) {
      throw new ContentTranslationServiceError('context-disposed');
    }
    try {
      return await active.session.translate(text);
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
    for (const [pairKey, active] of this.sessions) {
      if (active.id !== sessionId) continue;
      this.sessions.delete(pairKey);
      this.safeDestroySession(active.session);
      return;
    }
  }

  handleTrustedGesture(): void {
    if (this.disposed) return;
    for (const key of [...this.pendingActivation]) {
      this.pendingActivation.delete(key);
      const [sourceLanguage, targetLanguage] = key.split(':');
      if (sourceLanguage === undefined || targetLanguage === undefined) continue;
      if (this.sessions.has(key)) {
        this.onReady?.({ sourceLanguage, targetLanguage });
        continue;
      }
      // A settings/effect refresh may already have started another create
      // outside the gesture. Do not coalesce into that older request: native
      // model activation must start from this trusted event or the click can
      // be consumed without ever initializing the model.
      void this.beginCreate(key, sourceLanguage, targetLanguage, true)
        .then(() => {
          if (!this.disposed && this.sessions.has(key)) {
            this.onReady?.({ sourceLanguage, targetLanguage });
          }
        })
        .catch(() => {});
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingActivation.clear();
    this.creates.clear();
    this.createTokens.clear();
    for (const active of this.sessions.values()) {
      this.safeDestroySession(active.session);
    }
    this.sessions.clear();
  }

  private async createPair(
    key: string,
    sourceLanguage: string,
    targetLanguage: string,
    token: symbol,
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
      if (this.disposed || this.createTokens.get(key) !== token) {
        const replacement = this.disposed ? undefined : this.sessions.get(key);
        if (replacement?.session !== session) this.safeDestroySession(session);
        if (replacement !== undefined) return replacement.id;
        throw new ContentTranslationServiceError('context-disposed');
      }
      const previous = this.sessions.get(key);
      const sessionId = `${this.sessionNamespace}-${++this.sessionSequence}`;
      this.sessions.set(key, { id: sessionId, session });
      this.pendingActivation.delete(key);
      if (previous !== undefined && previous.session !== session) {
        this.safeDestroySession(previous.session);
      }
      return sessionId;
    } catch (error) {
      if (this.disposed) {
        throw new ContentTranslationServiceError('context-disposed');
      }
      if (this.createTokens.get(key) !== token) {
        const replacement = this.sessions.get(key);
        if (replacement !== undefined) return replacement.id;
        throw new ContentTranslationServiceError('context-disposed');
      }
      if (error instanceof ContentTranslationServiceError) throw error;
      if (isNamedError(error, 'NotAllowedError') || isNamedError(error, 'InvalidStateError')) {
        if (!this.sessions.has(key)) this.pendingActivation.add(key);
        throw new ContentTranslationServiceError('activation-required');
      }
      if (isNamedError(error, 'NotSupportedError')) {
        throw new ContentTranslationServiceError('unsupported-pair');
      }
      throw new ContentTranslationServiceError('translation-failed');
    }
  }

  private beginCreate(
    key: string,
    sourceLanguage: string,
    targetLanguage: string,
    replaceInFlight = false,
  ): Promise<string> {
    if (this.disposed) {
      return Promise.reject(new ContentTranslationServiceError('context-disposed'));
    }
    const inFlight = this.creates.get(key);
    if (!replaceInFlight && inFlight !== undefined) return inFlight;

    const token = Symbol(key);
    this.createTokens.set(key, token);
    let tracked!: Promise<string>;
    tracked = this.createPair(key, sourceLanguage, targetLanguage, token).finally(() => {
      if (this.creates.get(key) === tracked) this.creates.delete(key);
    });
    this.creates.set(key, tracked);
    return tracked;
  }

  private safeDestroySession(session: TranslatorSession): void {
    try {
      session.destroy();
    } catch {
      // Cleanup is best-effort when Chrome has already disposed the native
      // model context. The token still prevents the handle from reappearing.
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
