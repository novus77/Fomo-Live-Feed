/**
 * On-device opinion translation coordinator and result cache (Fomo feed
 * recovery plan, Task 7 foundation).
 *
 * Everything lives inside the Side Panel process: detection, translator
 * sessions, texts, cache, and results. There is no persistence and no
 * `chrome.runtime` messaging — a fresh coordinator starts with an empty
 * cache.
 *
 * Policy decisions (each pinned by tests in opinion-translation.test.ts):
 * - `target: 'auto'` (the default when no explicit target is given) resolves
 *   to the browser language, normalized to a supported base tag
 *   (`en-US` -> `en`, `zh-CN` -> `zh`). An unresolvable target leaves the
 *   text unchanged.
 * - Empty / whitespace-only / overlong text (default cap 2000 chars) is
 *   returned `unchanged` without touching the API or the hash function.
 * - The original text is SHA-256-hashed before it is used in a cache key.
 *   The cache is a bounded LRU (default 200 entries) and stores only
 *   terminal results (`translated`, `unchanged`); transient states
 *   (`activation-required`, `unavailable`, `failed`) are never cached so a
 *   model download or user opt-in is reflected on the next request.
 * - Concurrent requests for the same text + resolved target are coalesced
 *   into one API call.
 * - "Latest wins" preference changes: every `translate()` call gets a
 *   monotonic sequence number, and a cache write only lands if no newer
 *   request already wrote for that key — so an older in-flight request can
 *   never overwrite the result of a newer preference.
 * - At most `maxSessions` (default 1) live translator sessions are kept; a
 *   changed language pair evicts (and destroys) the previous session. All
 *   sessions are destroyed on `destroy()` (provider unmount). Evicting a
 *   session mid-translate may abort that in-flight request, which is
 *   reported as `failed` for that call.
 * - `downloadable` / `downloading` availability is NOT terminal: the
 *   coordinator still calls `create()`, which is what actually triggers (or
 *   awaits) the model download in Chrome. A rejection is mapped to
 *   `activation-required`.
 * - Concurrent session creation for the same language pair is coalesced into
 *   one `create()` call, and a session that resolves after `destroy()` is
 *   destroyed instead of stored.
 */

import type { BrowserTranslationApi, ModelAvailability, TranslatorSession } from './browser-translation';
import {
  TranslationActivationRequiredError,
  TranslationApiUnavailableError,
  TranslationUnsupportedPairError,
} from './browser-translation';

export type OpinionTranslationResult =
  | { status: 'unchanged'; original: string }
  | { status: 'translated'; original: string; translated: string }
  | { status: 'activation-required'; original: string }
  | { status: 'unavailable' | 'failed'; original: string };

export const DEFAULT_MAX_SOURCE_LENGTH = 2000;
export const DEFAULT_MAX_CACHE_ENTRIES = 200;
const DEFAULT_MAX_SESSIONS = 1;

/**
 * Only terminal results are worth caching. Transient states
 * (`activation-required`, `unavailable`, `failed`) are never stored so a
 * model download, user opt-in, or transient model failure is reflected on
 * the next request instead of being served stale.
 */
const CACHEABLE_STATUSES: ReadonlySet<OpinionTranslationResult['status']> = new Set([
  'translated',
  'unchanged',
]);

export interface OpinionTranslationDeps {
  api: BrowserTranslationApi;
  /** Reads the user's language (e.g. `navigator.language`) for `auto`. */
  browserLanguage: () => string;
  /** Cap on source text length; longer text is returned unchanged. */
  maxSourceLength?: number;
  /** Cap on the LRU result cache. */
  maxCacheEntries?: number;
  /** Cap on simultaneously live translator sessions (clamped to >= 1). */
  maxSessions?: number;
  /** SHA-256 by default; injectable for tests and exotic environments. */
  hashText?: (text: string) => Promise<string>;
}

interface CacheEntry {
  target: string;
  result: OpinionTranslationResult;
  /** Request sequence at write time, for latest-wins cache writes. */
  seq: number;
}

/**
 * Reduce a BCP-47 tag to the supported base language (primary subtag):
 * `en-US` -> `en`, `zh-CN` -> `zh`, `ZH-Hant` -> `zh`, `pt-BR` -> `pt`.
 * The whole tag must look like a BCP-47 tag (letter subtags separated by `-`
 * or `_`); anything else (empty, whitespace, digits, stray punctuation)
 * returns null so callers can fall back to leaving the text unchanged.
 */
export function normalizeLanguageTag(tag: string): string | null {
  const trimmed = tag.trim();
  if (!/^[a-zA-Z]{2,8}(?:[-_][a-zA-Z0-9]{1,8})*$/u.test(trimmed)) {
    return null;
  }
  return trimmed.split(/[-_]/u)[0]?.toLowerCase() ?? null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class OpinionTranslationCoordinator {
  private readonly api: BrowserTranslationApi;
  private readonly browserLanguage: () => string;
  private readonly maxSourceLength: number;
  private readonly maxCacheEntries: number;
  private readonly maxSessions: number;
  private readonly hashText: (text: string) => Promise<string>;

  /** LRU result cache keyed by SHA-256 of the original text. */
  private readonly cache = new Map<string, CacheEntry>();
  /** In-flight coalescing, keyed by `cacheKey \u0000 resolvedTarget`. */
  private readonly inflight = new Map<string, Promise<OpinionTranslationResult>>();
  /** Live translator sessions keyed by `source:target`, LRU-ordered. */
  private readonly sessions = new Map<string, TranslatorSession>();
  /** In-flight session creation keyed by `source:target` (same-pair dedupe). */
  private readonly sessionCreates = new Map<string, Promise<TranslatorSession>>();
  /** Monotonic request sequence so the newest preference wins cache writes. */
  private requestSeq = 0;
  private destroyed = false;

  constructor(deps: OpinionTranslationDeps) {
    this.api = deps.api;
    this.browserLanguage = deps.browserLanguage;
    this.maxSourceLength = deps.maxSourceLength ?? DEFAULT_MAX_SOURCE_LENGTH;
    this.maxCacheEntries = deps.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.maxSessions = Math.max(1, deps.maxSessions ?? DEFAULT_MAX_SESSIONS);
    this.hashText = deps.hashText ?? sha256Hex;
  }

  async translate(
    text: string,
    options: { target?: string } = {},
  ): Promise<OpinionTranslationResult> {
    this.assertUsable();

    if (text.trim().length === 0 || text.length > this.maxSourceLength) {
      return { status: 'unchanged', original: text };
    }

    const target = this.resolveTarget(options);
    if (target === null) {
      return { status: 'unchanged', original: text };
    }

    const key = await this.hashText(text);

    const cached = this.cache.get(key);
    if (cached !== undefined && cached.target === target) {
      this.touchCache(key);
      return cached.result;
    }

    const inflightKey = `${key}\u0000${target}`;
    const running = this.inflight.get(inflightKey);
    if (running !== undefined) {
      return running;
    }

    const seq = ++this.requestSeq;
    const promise = this.perform(text, target, key, seq).finally(() => {
      this.inflight.delete(inflightKey);
    });
    this.inflight.set(inflightKey, promise);
    return promise;
  }

  /**
   * Create and retain a translator session from a direct user gesture. Chrome
   * requires this once when the language pack has not been downloaded yet.
   */
  async prepare(sourceLanguage: string, targetLanguage: string): Promise<void> {
    this.assertUsable();
    const source = normalizeLanguageTag(sourceLanguage);
    const target = normalizeLanguageTag(targetLanguage);
    if (source === null || target === null || source === target) {
      throw new TranslationUnsupportedPairError();
    }
    await this.acquireSession(source, target);
  }

  /** Destroy every live session and drop all state (provider unmount). */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cache.clear();
    this.inflight.clear();
    this.sessionCreates.clear();
    for (const session of this.sessions.values()) {
      session.destroy();
    }
    this.sessions.clear();
  }

  private assertUsable(): void {
    if (this.destroyed) {
      throw new Error('OpinionTranslationCoordinator has been destroyed.');
    }
  }

  private resolveTarget(options: { target?: string }): string | null {
    let raw: string;
    try {
      raw = options.target ?? this.browserLanguage();
    } catch {
      return null;
    }
    return normalizeLanguageTag(raw);
  }

  private async perform(
    text: string,
    target: string,
    key: string,
    seq: number,
  ): Promise<OpinionTranslationResult> {
    const result = await this.translateUncached(text, target);
    if (!this.destroyed && CACHEABLE_STATUSES.has(result.status)) {
      this.storeCache(key, { target, result, seq });
    }
    return result;
  }

  private async translateUncached(
    text: string,
    target: string,
  ): Promise<OpinionTranslationResult> {
    let detected: { language: string } | null = null;
    try {
      detected = await this.api.detect(text);
    } catch (error) {
      return this.classifyDetectError(error, text);
    }

    const source = normalizeLanguageTag(detected.language);
    if (source === null) {
      return { status: 'unchanged', original: text };
    }
    if (source === target) {
      // Same-language bypass: never rewrite text already in the target
      // language.
      return { status: 'unchanged', original: text };
    }

    let availability: ModelAvailability;
    try {
      availability = await this.api.availability(source, target);
    } catch {
      availability = 'unavailable';
    }

    if (availability === 'unavailable') {
      return { status: 'unavailable', original: text };
    }
    // 'available', 'downloadable', and 'downloading' all proceed to
    // create(): Chrome either returns a usable session (starting or awaiting
    // the model download as needed) or rejects with an activation error,
    // which is mapped to activation-required below. The download states are
    // never terminal, so they must not short-circuit before create().

    let session: TranslatorSession;
    try {
      session = await this.acquireSession(source, target);
    } catch (error) {
      if (error instanceof TranslationActivationRequiredError) {
        return { status: 'activation-required', original: text };
      }
      if (
        error instanceof TranslationUnsupportedPairError ||
        error instanceof TranslationApiUnavailableError
      ) {
        return { status: 'unavailable', original: text };
      }
      return { status: 'failed', original: text };
    }

    try {
      const translated = await session.translate(text);
      return { status: 'translated', original: text, translated };
    } catch (error) {
      if (error instanceof TranslationActivationRequiredError) {
        return { status: 'activation-required', original: text };
      }
      if (error instanceof TranslationUnsupportedPairError) {
        return { status: 'unavailable', original: text };
      }
      return { status: 'failed', original: text };
    }
  }

  private classifyDetectError(error: unknown, text: string): OpinionTranslationResult {
    if (error instanceof TranslationApiUnavailableError) {
      return { status: 'unavailable', original: text };
    }
    if (error instanceof TranslationActivationRequiredError) {
      return { status: 'activation-required', original: text };
    }
    // Detection is advisory: an unrecognized failure means we cannot confirm
    // the text differs from the target, so we leave it untouched rather than
    // risk rewriting text the user already reads natively.
    return { status: 'unchanged', original: text };
  }

  private async acquireSession(source: string, target: string): Promise<TranslatorSession> {
    const pairKey = `${source}:${target}`;
    const existing = this.sessions.get(pairKey);
    if (existing !== undefined) {
      this.touchSession(pairKey);
      return existing;
    }

    // Coalesce concurrent session creation for the same language pair: N
    // cards asking for the same pair share ONE create() (and one session)
    // instead of each starting a download / creating a session.
    const inflight = this.sessionCreates.get(pairKey);
    if (inflight !== undefined) {
      return inflight;
    }

    const creating = this.createSession(pairKey, source, target);
    this.sessionCreates.set(pairKey, creating);
    try {
      return await creating;
    } finally {
      this.sessionCreates.delete(pairKey);
    }
  }

  private async createSession(
    pairKey: string,
    source: string,
    target: string,
  ): Promise<TranslatorSession> {
    const session = await this.api.create(source, target);

    // A destroy() may have landed while create() was in flight: never store
    // (or leak) a session created for a destroyed coordinator.
    if (this.destroyed) {
      session.destroy();
      throw new Error('OpinionTranslationCoordinator has been destroyed.');
    }

    // Evict the least-recently-used session first so a changed language pair
    // cannot accumulate live sessions. Evicted sessions are destroyed.
    while (this.sessions.size >= this.maxSessions) {
      const oldestKey = this.sessions.keys().next().value;
      if (oldestKey === undefined) break;
      const evicted = this.sessions.get(oldestKey);
      this.sessions.delete(oldestKey);
      evicted?.destroy();
    }
    this.sessions.set(pairKey, session);
    return session;
  }

  private touchCache(key: string): void {
    const entry = this.cache.get(key);
    if (entry === undefined) return;
    this.cache.delete(key);
    this.cache.set(key, entry);
  }

  private storeCache(key: string, entry: CacheEntry): void {
    const existing = this.cache.get(key);
    if (existing !== undefined && existing.seq > entry.seq) {
      // A newer request already wrote this key; the older preference loses.
      return;
    }
    this.cache.delete(key); // refresh LRU position even when overwriting
    this.cache.set(key, entry);
    while (this.cache.size > this.maxCacheEntries) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey === undefined) break;
      this.cache.delete(oldestKey);
    }
  }

  private touchSession(pairKey: string): void {
    const session = this.sessions.get(pairKey);
    if (session === undefined) return;
    this.sessions.delete(pairKey);
    this.sessions.set(pairKey, session);
  }
}
