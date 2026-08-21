import { describe, expect, it, vi } from 'vitest';

import {
  TranslationActivationRequiredError,
  TranslationApiUnavailableError,
  TranslationUnsupportedPairError,
  type ModelAvailability,
} from '../../src/translation/browser-translation';
import {
  DEFAULT_MAX_CACHE_ENTRIES,
  DEFAULT_MAX_SOURCE_LENGTH,
  OpinionTranslationCoordinator,
  normalizeLanguageTag,
  type OpinionTranslationResult,
} from '../../src/translation/opinion-translation';

type MockSession = {
  translate: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

interface MakeApiOptions {
  languageByText?: Record<string, string>;
  defaultLanguage?: string;
  availability?: ModelAvailability | ((source: string, target: string) => ModelAvailability);
  createError?: (source: string, target: string) => unknown;
  detectError?: (text: string) => unknown;
  translateError?: (text: string) => unknown;
  translateImpl?: (text: string) => Promise<string> | string;
  createImpl?: (source: string, target: string) => Promise<MockSession>;
}

function makeDefaultSession(
  source: string,
  target: string,
  options?: MakeApiOptions,
): MockSession {
  return {
    translate: vi.fn(async (text: string) => {
      const translateError = options?.translateError?.(text);
      if (translateError !== undefined) throw translateError;
      if (options?.translateImpl !== undefined) return options.translateImpl(text);
      return `[${source}->${target}] ${text}`;
    }),
    destroy: vi.fn(),
  };
}

/**
 * A fake `BrowserTranslationApi` that detects the language of a text from an
 * explicit map (default `es`, so the translation path is exercised by
 * default; same-language tests override it).
 */
function makeApi(options?: MakeApiOptions) {
  const languageByText = options?.languageByText ?? {};
  const defaultLanguage = options?.defaultLanguage ?? 'es';
  const sessions: MockSession[] = [];

  const api = {
    sessions,
    detect: vi.fn(async (text: string) => {
      const detectError = options?.detectError?.(text);
      if (detectError !== undefined) throw detectError;
      return { language: languageByText[text] ?? defaultLanguage, confidence: 0.99 };
    }),
    availability: vi.fn(async (source: string, target: string) => {
      const availability = options?.availability;
      if (typeof availability === 'function') return availability(source, target);
      return availability ?? 'available';
    }),
    create: vi.fn(async (source: string, target: string) => {
      const createError = options?.createError?.(source, target);
      if (createError !== undefined) throw createError;
      if (options?.createImpl !== undefined) {
        const session = await options.createImpl(source, target);
        sessions.push(session);
        return session;
      }
      const session = makeDefaultSession(source, target, options);
      sessions.push(session);
      return session;
    }),
  };

  return api;
}

function makeDeferredSession(target: string): {
  handle: MockSession;
  resolve: (value: string) => void;
} {
  // The gate is created eagerly so `resolve` is assignable immediately; the
  // session merely awaits the same promise when the pipeline reaches it.
  let resolve!: (value: string) => void;
  const gate = new Promise<string>((res) => {
    resolve = res;
  });
  const handle: MockSession = {
    translate: vi.fn(() => gate),
    destroy: vi.fn(),
  };
  return { handle, resolve: (value: string) => resolve(value) };
}

describe('normalizeLanguageTag', () => {
  it.each([
    ['en-US', 'en'],
    ['zh-CN', 'zh'],
    ['ZH-Hant', 'zh'],
    ['pt-BR', 'pt'],
    ['es-419', 'es'],
    ['zh-Hans-CN', 'zh'],
    ['en', 'en'],
    ['  en-US  ', 'en'],
  ])('normalizes %j to %j', (tag, expected) => {
    expect(normalizeLanguageTag(tag)).toBe(expected);
  });

  it.each(['', '   ', '123', 'not a tag!', 'e', 'en_US!', 'en-', '-en'])(
    'rejects %j',
    (tag) => {
      expect(normalizeLanguageTag(tag)).toBeNull();
    },
  );
});

describe('OpinionTranslationCoordinator', () => {
  describe('target resolution', () => {
    it('resolves the auto target from the browser language as a base tag', async () => {
      const api = makeApi({ languageByText: { hello: 'es' } });
      const coordinator = new OpinionTranslationCoordinator({
        api,
        browserLanguage: () => 'zh-CN',
      });

      const result = await coordinator.translate('hello');

      expect(result).toEqual({
        status: 'translated',
        original: 'hello',
        translated: '[es->zh] hello',
      });
      expect(api.availability).toHaveBeenCalledWith('es', 'zh');
      expect(api.create).toHaveBeenCalledWith('es', 'zh');
    });

    it('prefers an explicit target over the browser language', async () => {
      const api = makeApi({ languageByText: { hello: 'es' } });
      const coordinator = new OpinionTranslationCoordinator({
        api,
        browserLanguage: () => 'en',
      });

      await coordinator.translate('hello', { target: 'fr' });

      expect(api.create).toHaveBeenCalledWith('es', 'fr');
      expect(api.create).not.toHaveBeenCalledWith('es', 'en');
    });

    it('leaves text unchanged when no target can be resolved', async () => {
      const api = makeApi();
      const emptyLanguage = new OpinionTranslationCoordinator({
        api,
        browserLanguage: () => '',
      });
      const invalidLanguage = new OpinionTranslationCoordinator({
        api,
        browserLanguage: () => 'not a tag!',
      });

      await expect(emptyLanguage.translate('hello')).resolves.toEqual({
        status: 'unchanged',
        original: 'hello',
      });
      await expect(invalidLanguage.translate('hello')).resolves.toEqual({
        status: 'unchanged',
        original: 'hello',
      });
      expect(api.detect).not.toHaveBeenCalled();
    });

    it('leaves text unchanged when the browser language getter throws', async () => {
      const api = makeApi();
      const coordinator = new OpinionTranslationCoordinator({
        api,
        browserLanguage: () => {
          throw new Error('navigator gone');
        },
      });

      await expect(coordinator.translate('hello')).resolves.toEqual({
        status: 'unchanged',
        original: 'hello',
      });
    });
  });

  describe('same-language bypass', () => {
    it('bypasses translation when the detected source equals the target', async () => {
      const api = makeApi({ languageByText: { hello: 'en' } });
      const coordinator = new OpinionTranslationCoordinator({
        api,
        browserLanguage: () => 'en-US',
      });

      const result = await coordinator.translate('hello');

      expect(result).toEqual({ status: 'unchanged', original: 'hello' });
      expect(api.availability).not.toHaveBeenCalled();
      expect(api.create).not.toHaveBeenCalled();
    });

    it('normalizes detected language tags before the same-language check', async () => {
      const api = makeApi({ languageByText: { hello: 'EN-us' } });
      const coordinator = new OpinionTranslationCoordinator({
        api,
        browserLanguage: () => 'en',
      });

      await expect(coordinator.translate('hello')).resolves.toEqual({
        status: 'unchanged',
        original: 'hello',
      });
    });

    it('leaves text unchanged when the detected language is not a usable tag', async () => {
      const api = makeApi({ languageByText: { hello: '???' } });
      const coordinator = new OpinionTranslationCoordinator({
        api,
        browserLanguage: () => 'en',
      });

      await expect(coordinator.translate('hello')).resolves.toEqual({
        status: 'unchanged',
        original: 'hello',
      });
      expect(api.create).not.toHaveBeenCalled();
    });
  });

  describe('result mapping', () => {
    it('maps an unavailable model to an unavailable result', async () => {
      const api = makeApi({ languageByText: { hello: 'es' } });
      api.availability.mockResolvedValue('unavailable');
      const coordinator = new OpinionTranslationCoordinator({ api, browserLanguage: () => 'en' });

      await expect(coordinator.translate('hello')).resolves.toEqual({
        status: 'unavailable',
        original: 'hello',
      });
      expect(api.create).not.toHaveBeenCalled();
    });

    it.each(['downloadable', 'downloading'] as const)(
      'maps a %s model to activation-required',
      async (availability) => {
        const api = makeApi({ languageByText: { hello: 'es' } });
        api.availability.mockResolvedValue(availability);
        const coordinator = new OpinionTranslationCoordinator({ api, browserLanguage: () => 'en' });

        await expect(coordinator.translate('hello')).resolves.toEqual({
          status: 'activation-required',
          original: 'hello',
        });
        expect(api.create).not.toHaveBeenCalled();
      },
    );

    it('maps a create() activation error to activation-required', async () => {
      const api = makeApi({
        languageByText: { hello: 'es' },
        createError: () => new TranslationActivationRequiredError(),
      });
      const coordinator = new OpinionTranslationCoordinator({ api, browserLanguage: () => 'en' });

      await expect(coordinator.translate('hello')).resolves.toEqual({
        status: 'activation-required',
        original: 'hello',
      });
    });

    it('maps an unsupported language pair to unavailable', async () => {
      const api = makeApi({
        languageByText: { hello: 'es' },
        createError: () => new TranslationUnsupportedPairError(),
      });
      const coordinator = new OpinionTranslationCoordinator({ api, browserLanguage: () => 'en' });

      await expect(coordinator.translate('hello')).resolves.toEqual({
        status: 'unavailable',
        original: 'hello',
      });
    });

    it('maps a rejected translation to failed', async () => {
      const api = makeApi({
        languageByText: { hello: 'es' },
        translateError: () => new Error('model crashed'),
      });
      const coordinator = new OpinionTranslationCoordinator({ api, browserLanguage: () => 'en' });

      await expect(coordinator.translate('hello')).resolves.toEqual({
        status: 'failed',
        original: 'hello',
      });
    });

    it('maps a missing API to unavailable', async () => {
      const api = makeApi({ detectError: () => new TranslationApiUnavailableError() });
      const coordinator = new OpinionTranslationCoordinator({ api, browserLanguage: () => 'en' });

      await expect(coordinator.translate('hello')).resolves.toEqual({
        status: 'unavailable',
        original: 'hello',
      });
    });

    it('leaves text unchanged when detection fails for an unknown reason', async () => {
      const api = makeApi({ detectError: () => new Error('detector crashed') });
      const coordinator = new OpinionTranslationCoordinator({ api, browserLanguage: () => 'en' });

      await expect(coordinator.translate('hello')).resolves.toEqual({
        status: 'unchanged',
        original: 'hello',
      });
      expect(api.create).not.toHaveBeenCalled();
    });
  });

  describe('hashing and caching', () => {
    it('hashes the original text before using it in a cache key', async () => {
      const hashText = vi.fn(async (text: string) => `key:${text}`);
      const api = makeApi({ languageByText: { hello: 'es' } });
      const coordinator = new OpinionTranslationCoordinator({
        api,
        browserLanguage: () => 'en',
        hashText,
      });

      await coordinator.translate('hello');

      expect(hashText).toHaveBeenCalledWith('hello');
      expect(hashText.mock.invocationCallOrder[0]).toBeLessThan(
        api.detect.mock.invocationCallOrder[0]!,
      );
    });

    it('uses a real SHA-256 digest of the original text by default', async () => {
      const digestSpy = vi.spyOn(crypto.subtle, 'digest');
      try {
        const api = makeApi({ languageByText: { hello: 'es' } });
        const coordinator = new OpinionTranslationCoordinator({ api, browserLanguage: () => 'en' });

        await coordinator.translate('hello');

        expect(digestSpy).toHaveBeenCalledWith('SHA-256', new TextEncoder().encode('hello'));
      } finally {
        digestSpy.mockRestore();
      }
    });

    it('serves repeated requests for the same text from the cache', async () => {
      const api = makeApi({ languageByText: { hello: 'es' } });
      const coordinator = new OpinionTranslationCoordinator({ api, browserLanguage: () => 'en' });

      const first = await coordinator.translate('hello');
      const second = await coordinator.translate('hello');

      expect(second).toBe(first);
      expect(api.detect).toHaveBeenCalledTimes(1);
      expect(api.create).toHaveBeenCalledTimes(1);
      expect(api.sessions[0]!.translate).toHaveBeenCalledTimes(1);
    });

    it('evicts the least-recently-used cache entry at 200 entries', async () => {
      const api = makeApi();
      const coordinator = new OpinionTranslationCoordinator({ api, browserLanguage: () => 'en' });
      const texts = Array.from({ length: DEFAULT_MAX_CACHE_ENTRIES + 1 }, (_, i) => `text-${i}`);

      for (const text of texts) {
        await coordinator.translate(text);
      }

      const session = api.sessions[0]!;
      expect(session.translate).toHaveBeenCalledTimes(DEFAULT_MAX_CACHE_ENTRIES + 1);
      expect(api.create).toHaveBeenCalledTimes(1); // one pair, one live session

      // text-0 was evicted; re-translating it must miss the cache.
      await coordinator.translate(texts[0]!);
      expect(session.translate).toHaveBeenCalledTimes(DEFAULT_MAX_CACHE_ENTRIES + 2);

      // The newest entry is still cached.
      await coordinator.translate(texts[DEFAULT_MAX_CACHE_ENTRIES]!);
      expect(session.translate).toHaveBeenCalledTimes(DEFAULT_MAX_CACHE_ENTRIES + 2);
    });

    it('respects a configurable cache cap', async () => {
      const api = makeApi();
      const coordinator = new OpinionTranslationCoordinator({
        api,
        browserLanguage: () => 'en',
        maxCacheEntries: 2,
      });

      await coordinator.translate('a');
      await coordinator.translate('b');
      await coordinator.translate('c'); // evicts 'a'
      await coordinator.translate('a'); // miss again
      await coordinator.translate('c'); // still cached

      const session = api.sessions[0]!;
      expect(session.translate).toHaveBeenCalledTimes(4);
    });

    it('does not cache transient states so a later opt-in is honored', async () => {
      const api = makeApi({ languageByText: { hello: 'es' } });
      api.availability.mockResolvedValue('downloadable');
      const coordinator = new OpinionTranslationCoordinator({ api, browserLanguage: () => 'en' });

      await expect(coordinator.translate('hello')).resolves.toEqual({
        status: 'activation-required',
        original: 'hello',
      });
      expect(api.create).not.toHaveBeenCalled();

      api.availability.mockResolvedValue('available');
      await expect(coordinator.translate('hello')).resolves.toMatchObject({
        status: 'translated',
      });
      expect(api.create).toHaveBeenCalledTimes(1);
    });

    it('does not cache a failed translation', async () => {
      let shouldFail = true;
      const api = makeApi({
        languageByText: { hello: 'es' },
        translateError: () => (shouldFail ? new Error('model crashed') : undefined),
      });
      const coordinator = new OpinionTranslationCoordinator({ api, browserLanguage: () => 'en' });

      await expect(coordinator.translate('hello')).resolves.toEqual({
        status: 'failed',
        original: 'hello',
      });

      shouldFail = false;
      await expect(coordinator.translate('hello')).resolves.toMatchObject({
        status: 'translated',
      });
    });

    it('keeps no state across instances (no persistence)', async () => {
      const api = makeApi({ languageByText: { hello: 'es' } });
      const first = new OpinionTranslationCoordinator({ api, browserLanguage: () => 'en' });
      await first.translate('hello');
      expect(api.sessions).toHaveLength(1);

      const second = new OpinionTranslationCoordinator({ api, browserLanguage: () => 'en' });
      const result = await second.translate('hello');

      expect(result).toMatchObject({ status: 'translated' });
      // The second instance had to create its own session and translate again:
      // nothing is shared or persisted between coordinator instances.
      expect(api.sessions).toHaveLength(2);
      expect(api.sessions[1]!.translate).toHaveBeenCalledTimes(1);
    });
  });

  describe('concurrency', () => {
    it('coalesces concurrent requests for the same text and target', async () => {
      let resolveTranslate!: (value: string) => void;
      const gate = new Promise<string>((resolve) => {
        resolveTranslate = resolve;
      });
      const api = makeApi({
        languageByText: { hello: 'es' },
        translateImpl: () => gate,
      });
      const coordinator = new OpinionTranslationCoordinator({ api, browserLanguage: () => 'en' });

      const first = coordinator.translate('hello');
      const second = coordinator.translate('hello');
      resolveTranslate('[es->en] hello');

      const [r1, r2] = await Promise.all([first, second]);

      expect(r1).toBe(r2);
      expect(r1).toEqual({ status: 'translated', original: 'hello', translated: '[es->en] hello' });
      expect(api.create).toHaveBeenCalledTimes(1);
      expect(api.sessions[0]!.translate).toHaveBeenCalledTimes(1);
    });

    it('lets the latest preference win when requests complete out of order', async () => {
      let language = 'en';
      const sessionEn = makeDeferredSession('en');
      const sessionZh = makeDeferredSession('zh');
      const api = makeApi({
        createImpl: async (_source: string, target: string) =>
          target === 'en' ? sessionEn.handle : sessionZh.handle,
      });
      const coordinator = new OpinionTranslationCoordinator({
        api,
        browserLanguage: () => language,
      });

      const older = coordinator.translate('hello'); // target en (auto)
      language = 'zh';
      const newer = coordinator.translate('hello'); // target zh

      sessionZh.resolve('[es->zh] hello');
      await expect(newer).resolves.toEqual({
        status: 'translated',
        original: 'hello',
        translated: '[es->zh] hello',
      });

      sessionEn.resolve('[es->en] hello');
      await expect(older).resolves.toEqual({
        status: 'translated',
        original: 'hello',
        translated: '[es->en] hello',
      });

      // The cache must reflect the newest preference, not the stale slow one.
      await expect(coordinator.translate('hello')).resolves.toEqual({
        status: 'translated',
        original: 'hello',
        translated: '[es->zh] hello',
      });
    });
  });

  describe('session lifecycle', () => {
    it('reuses the live session for the same language pair', async () => {
      const api = makeApi();
      const coordinator = new OpinionTranslationCoordinator({ api, browserLanguage: () => 'en' });

      await coordinator.translate('one');
      await coordinator.translate('two');

      expect(api.create).toHaveBeenCalledTimes(1);
      expect(api.sessions[0]!.translate).toHaveBeenCalledTimes(2);
    });

    it('evicts and destroys the previous session when the language pair changes', async () => {
      let language = 'en';
      const api = makeApi();
      const coordinator = new OpinionTranslationCoordinator({
        api,
        browserLanguage: () => language,
      });

      await coordinator.translate('hello');
      expect(api.sessions).toHaveLength(1);
      const first = api.sessions[0]!;
      expect(first.destroy).not.toHaveBeenCalled();

      language = 'zh';
      await coordinator.translate('hello');

      expect(api.sessions).toHaveLength(2);
      const second = api.sessions[1]!;
      expect(first.destroy).toHaveBeenCalledTimes(1);
      expect(second.destroy).not.toHaveBeenCalled();
      expect(api.create).toHaveBeenCalledTimes(2);

      // The new pair reuses its live session.
      await coordinator.translate('world');
      expect(api.create).toHaveBeenCalledTimes(2);
      expect(second.translate).toHaveBeenCalledTimes(2);

      // Provider unmount destroys the current session and blocks new work.
      coordinator.destroy();
      expect(second.destroy).toHaveBeenCalledTimes(1);
      await expect(coordinator.translate('x')).rejects.toThrow('destroyed');
    });

    it('is safe to destroy twice', async () => {
      const api = makeApi();
      const coordinator = new OpinionTranslationCoordinator({ api, browserLanguage: () => 'en' });
      await coordinator.translate('hello');

      coordinator.destroy();
      coordinator.destroy();

      expect(api.sessions[0]!.destroy).toHaveBeenCalledTimes(1);
    });
  });

  describe('source bounds', () => {
    it('returns unchanged for empty or whitespace-only text without touching the API', async () => {
      const hashText = vi.fn(async (text: string) => text);
      const api = makeApi();
      const coordinator = new OpinionTranslationCoordinator({
        api,
        browserLanguage: () => 'en',
        hashText,
      });

      for (const text of ['', '   ', '\n\t']) {
        await expect(coordinator.translate(text)).resolves.toEqual({
          status: 'unchanged',
          original: text,
        });
      }
      expect(api.detect).not.toHaveBeenCalled();
      expect(hashText).not.toHaveBeenCalled();
    });

    it(`caps the source text length at ${DEFAULT_MAX_SOURCE_LENGTH} chars by default`, async () => {
      const hashText = vi.fn(async (text: string) => text);
      const api = makeApi();
      const coordinator = new OpinionTranslationCoordinator({
        api,
        browserLanguage: () => 'en',
        hashText,
      });

      const overlong = 'x'.repeat(DEFAULT_MAX_SOURCE_LENGTH + 1);
      await expect(coordinator.translate(overlong)).resolves.toEqual({
        status: 'unchanged',
        original: overlong,
      });
      expect(api.detect).not.toHaveBeenCalled();
      expect(hashText).not.toHaveBeenCalled();

      const boundary = 'x'.repeat(DEFAULT_MAX_SOURCE_LENGTH);
      await expect(coordinator.translate(boundary)).resolves.toMatchObject({
        status: 'translated',
      });
    });

    it('honors a custom source length cap', async () => {
      const api = makeApi();
      const coordinator = new OpinionTranslationCoordinator({
        api,
        browserLanguage: () => 'en',
        maxSourceLength: 5,
      });

      await expect(coordinator.translate('hello')).resolves.toMatchObject({
        status: 'translated',
      });
      await expect(coordinator.translate('world!')).resolves.toEqual({
        status: 'unchanged',
        original: 'world!',
      });
    });
  });
});

// Result-type sanity: every status carries its required fields.
const _results: OpinionTranslationResult[] = [
  { status: 'unchanged', original: 'x' },
  { status: 'translated', original: 'x', translated: 'y' },
  { status: 'activation-required', original: 'x' },
  { status: 'unavailable', original: 'x' },
  { status: 'failed', original: 'x' },
];
void _results;
