import type { BrowserTranslationApi, TranslatorSession } from './browser-translation';

const GOOGLE_TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t';
const MAX_CACHE_ENTRIES = 400;
const MAX_TEXT_LENGTH = 2_000;

export interface GoogleTranslationGatewayDependencies {
  fetchImpl?: typeof fetch;
}

/**
 * Small, bounded gateway for the same Google web-translation endpoint used
 * by j7tracker-zh. It is used only after the local Chrome translator cannot
 * serve an opinion.
 */
export class GoogleTranslationGateway {
  private readonly fetchImpl: typeof fetch;
  private readonly cache = new Map<string, string>();
  private queue: Promise<void> = Promise.resolve();

  constructor(deps: GoogleTranslationGatewayDependencies = {}) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  async translate(text: string, targetLanguage: string): Promise<string> {
    if (text.trim().length === 0 || text.length > MAX_TEXT_LENGTH) {
      throw new Error('translation input is invalid');
    }
    const key = `${targetLanguage}\u0000${text}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    let result = '';
    this.queue = this.queue
      .catch(() => {})
      .then(async () => {
        const response = await Reflect.apply(this.fetchImpl, globalThis, [
          `${GOOGLE_TRANSLATE_URL}&tl=${encodeURIComponent(targetLanguage)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
            body: `q=${encodeURIComponent(text)}`,
          },
        ]);
        if (!response.ok) throw new Error(`Google Translate returned ${response.status}`);
        const payload: unknown = await response.json();
        result = extractTranslation(payload);
        if (result.length === 0) throw new Error('Google Translate returned an empty translation');
        if (this.cache.size >= MAX_CACHE_ENTRIES) this.cache.clear();
        this.cache.set(key, result);
      });
    await this.queue;
    return result;
  }
}

export function createLocalFirstTranslationApi(local: BrowserTranslationApi): BrowserTranslationApi {
  const google = new GoogleTranslationGateway();
  return {
    detect: (text) => local.detect(text),
    async availability(sourceLanguage, targetLanguage) {
      const state = await local.availability(sourceLanguage, targetLanguage).catch(() => 'unavailable' as const);
      return state === 'unavailable' ? 'available' : state;
    },
    async create(sourceLanguage, targetLanguage): Promise<TranslatorSession> {
      try {
        const session = await local.create(sourceLanguage, targetLanguage);
        return { translate: async (text) => session.translate(text).catch(() => google.translate(text, targetLanguage)), destroy: () => session.destroy() };
      } catch {
        return { translate: (text) => google.translate(text, targetLanguage), destroy: () => {} };
      }
    },
  };
}

function extractTranslation(payload: unknown): string {
  if (!Array.isArray(payload) || !Array.isArray(payload[0])) return '';
  return payload[0]
    .map((segment) => Array.isArray(segment) && typeof segment[0] === 'string' ? segment[0] : '')
    .join('');
}
