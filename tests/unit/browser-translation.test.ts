import { describe, expect, it, vi } from 'vitest';

import {
  TranslationActivationRequiredError,
  TranslationApiUnavailableError,
  TranslationUnsupportedPairError,
  createBrowserTranslationApi,
  type BrowserTranslationApi,
  type ModelAvailability,
} from '../../src/translation/browser-translation';

interface FakeTranslator {
  create: ReturnType<typeof vi.fn>;
  availability: ReturnType<typeof vi.fn>;
}

interface FakeDetector {
  create: ReturnType<typeof vi.fn>;
  availability: ReturnType<typeof vi.fn>;
}

function makeSession(overrides?: {
  translate?: ReturnType<typeof vi.fn>;
  destroy?: ReturnType<typeof vi.fn>;
}) {
  return {
    translate: overrides?.translate ?? vi.fn(async (text: string) => `translated(${text})`),
    destroy: overrides?.destroy ?? vi.fn(),
  };
}

function makeTranslator(overrides?: {
  availability?: ReturnType<typeof vi.fn>;
  create?: ReturnType<typeof vi.fn>;
}): FakeTranslator {
  return {
    availability:
      overrides?.availability ?? vi.fn(async () => 'available' as ModelAvailability),
    create: overrides?.create ?? vi.fn(async () => makeSession()),
  };
}

function makeDetector(overrides?: {
  create?: ReturnType<typeof vi.fn>;
  availability?: ReturnType<typeof vi.fn>;
}): FakeDetector {
  return {
    availability:
      overrides?.availability ?? vi.fn(async () => 'available' as ModelAvailability),
    create:
      overrides?.create ??
      vi.fn(async () => ({
        detect: vi.fn(async () => [
          { detectedLanguage: 'en', confidence: 0.95 },
          { detectedLanguage: 'es', confidence: 0.05 },
        ]),
        destroy: vi.fn(),
      })),
  };
}

const invalidStateError = () => new DOMException('not enabled', 'InvalidStateError');
const notAllowedError = () => new DOMException('activation required', 'NotAllowedError');
const notSupportedError = () => new DOMException('pair unsupported', 'NotSupportedError');

describe('createBrowserTranslationApi', () => {
  describe('feature detection / missing API', () => {
    it('reports the API missing when no globals exist in the injected environment', async () => {
      const api = createBrowserTranslationApi({});

      await expect(api.availability('en', 'es')).resolves.toBe('unavailable');
      await expect(api.detect('hello')).rejects.toBeInstanceOf(TranslationApiUnavailableError);
      await expect(api.create('en', 'es')).rejects.toBeInstanceOf(TranslationApiUnavailableError);
    });

    it('reports the API missing when reading the default global environment', async () => {
      // jsdom does not define Translator / LanguageDetector.
      const api = createBrowserTranslationApi();

      await expect(api.availability('en', 'es')).resolves.toBe('unavailable');
      await expect(api.create('en', 'es')).rejects.toBeInstanceOf(TranslationApiUnavailableError);
    });

    it('reports the API missing when only the detector exists', async () => {
      const api = createBrowserTranslationApi({ LanguageDetector: makeDetector() });

      await expect(api.availability('en', 'es')).resolves.toBe('unavailable');
      await expect(api.create('en', 'es')).rejects.toBeInstanceOf(TranslationApiUnavailableError);
      await expect(api.detect('hello')).resolves.toMatchObject({ language: 'en' });
    });

    it('returns unavailable when the Translator has no availability static', async () => {
      const translator = makeTranslator();
      delete (translator as { availability?: unknown }).availability;
      const api = createBrowserTranslationApi({ Translator: translator });

      await expect(api.availability('en', 'es')).resolves.toBe('unavailable');
    });
  });

  describe('model availability', () => {
    it('passes through an already-available model', async () => {
      const translator = makeTranslator();
      const api = createBrowserTranslationApi({ Translator: translator });

      await expect(api.availability('en', 'es')).resolves.toBe('available');
      expect(translator.availability).toHaveBeenCalledWith({ sourceLanguage: 'en', targetLanguage: 'es' });
    });

    it('passes through model download progress states', async () => {
      const translator = makeTranslator();
      translator.availability
        .mockResolvedValueOnce('downloadable')
        .mockResolvedValueOnce('downloading');
      const api = createBrowserTranslationApi({ Translator: translator });

      await expect(api.availability('en', 'es')).resolves.toBe('downloadable');
      await expect(api.availability('en', 'es')).resolves.toBe('downloading');
    });

    it('normalizes the legacy installed state to available', async () => {
      const translator = makeTranslator();
      translator.availability.mockResolvedValue('installed');
      const api = createBrowserTranslationApi({ Translator: translator });

      await expect(api.availability('en', 'es')).resolves.toBe('available');
    });

    it('reports unsupported pairs as unavailable', async () => {
      const translator = makeTranslator();
      translator.availability.mockResolvedValue('unavailable');
      const api = createBrowserTranslationApi({ Translator: translator });

      await expect(api.availability('en', 'es')).resolves.toBe('unavailable');
    });

    it('degrades to unavailable when the availability call rejects', async () => {
      const translator = makeTranslator();
      translator.availability.mockRejectedValue(new Error('crash'));
      const api = createBrowserTranslationApi({ Translator: translator });

      await expect(api.availability('en', 'es')).resolves.toBe('unavailable');
    });
  });

  describe('session creation', () => {
    it('reports translator model download progress from create monitor', async () => {
      const progress = vi.fn();
      const session = {
        translate: vi.fn(async (text: string) => `translated(${text})`),
        destroy: vi.fn(),
      };
      const create = vi.fn(async (options: {
        monitor?: (monitor: { addEventListener(type: string, listener: (event: { loaded: number }) => void): void }) => void;
      }) => {
        options.monitor?.({
          addEventListener: (_type, listener) => listener({ loaded: 0.4 }),
        });
        return session;
      });
      const api = createBrowserTranslationApi(
        { Translator: { availability: vi.fn(async () => 'downloadable'), create } },
        { onDownloadProgress: progress },
      );

      await api.create('en', 'zh');

      expect(progress).toHaveBeenCalledWith({ kind: 'translator', progress: 0.4 });
    });

    it('creates a working session for an available model', async () => {
      const api = createBrowserTranslationApi({
        Translator: makeTranslator(),
        LanguageDetector: makeDetector(),
      });

      const session = await api.create('en', 'es');
      await expect(session.translate('hello')).resolves.toBe('translated(hello)');
    });

    it('flags user activation required when create rejects with InvalidStateError', async () => {
      const translator = makeTranslator();
      translator.create.mockRejectedValue(invalidStateError());
      const api = createBrowserTranslationApi({ Translator: translator });

      await expect(api.create('en', 'es')).rejects.toBeInstanceOf(
        TranslationActivationRequiredError,
      );
    });

    it('flags user activation required when create rejects with NotAllowedError', async () => {
      const translator = makeTranslator();
      translator.create.mockRejectedValue(notAllowedError());
      const api = createBrowserTranslationApi({ Translator: translator });

      await expect(api.create('en', 'zh')).rejects.toBeInstanceOf(
        TranslationActivationRequiredError,
      );
    });

    it('reports unsupported pairs when create rejects with NotSupportedError', async () => {
      const translator = makeTranslator();
      translator.create.mockRejectedValue(notSupportedError());
      const api = createBrowserTranslationApi({ Translator: translator });

      await expect(api.create('en', 'es')).rejects.toBeInstanceOf(
        TranslationUnsupportedPairError,
      );
    });

    it('propagates unexpected create failures unchanged', async () => {
      const translator = makeTranslator();
      translator.create.mockRejectedValue(new Error('boom'));
      const api = createBrowserTranslationApi({ Translator: translator });

      await expect(api.create('en', 'es')).rejects.toThrow('boom');
    });

    it('propagates translation rejections from the session', async () => {
      const session = makeSession({ translate: vi.fn().mockRejectedValue(new Error('model error')) });
      const api = createBrowserTranslationApi({
        Translator: makeTranslator({ create: vi.fn(async () => session) }),
      });

      const wrapper = await api.create('en', 'es');
      await expect(wrapper.translate('hello')).rejects.toThrow('model error');
    });

    it('destroys the underlying session on wrapper destroy', async () => {
      const session = makeSession();
      const api = createBrowserTranslationApi({
        Translator: makeTranslator({ create: vi.fn(async () => session) }),
      });

      const wrapper = await api.create('en', 'es');
      expect(session.destroy).not.toHaveBeenCalled();
      wrapper.destroy();
      expect(session.destroy).toHaveBeenCalledTimes(1);
    });
  });

  describe('language detection', () => {
    it('uses a local English hint without creating a detector session', async () => {
      const detector = makeDetector();
      const api = createBrowserTranslationApi({ LanguageDetector: detector });

      await expect(
        api.detect('This is the official token and buyers are accumulating.'),
      ).resolves.toEqual({ language: 'en', confidence: 1 });
      expect(detector.create).not.toHaveBeenCalled();
    });

    it('uses a local Chinese hint without creating a detector session', async () => {
      const detector = makeDetector();
      const api = createBrowserTranslationApi({ LanguageDetector: detector });

      await expect(api.detect('这是官方代币，最近有很多钱包在持续买入。')).resolves.toEqual({
        language: 'zh',
        confidence: 1,
      });
      expect(detector.create).not.toHaveBeenCalled();
    });

    it('picks the highest-confidence candidate', async () => {
      const detector = makeDetector({
        create: vi.fn(async () => ({
          detect: vi.fn(async () => [
            { detectedLanguage: 'en', confidence: 0.3 },
            { detectedLanguage: 'es', confidence: 0.9 },
          ]),
          destroy: vi.fn(),
        })),
      });
      const api = createBrowserTranslationApi({ LanguageDetector: detector });

      await expect(api.detect('hola')).resolves.toEqual({ language: 'es', confidence: 0.9 });
    });

    it('reads the legacy language field when detectedLanguage is absent', async () => {
      const detector = makeDetector({
        create: vi.fn(async () => ({
          detect: vi.fn(async () => [{ language: 'zh', confidence: 0.8 }]),
          destroy: vi.fn(),
        })),
      });
      const api = createBrowserTranslationApi({ LanguageDetector: detector });

      await expect(api.detect('你好')).resolves.toEqual({ language: 'zh', confidence: 0.8 });
    });

    it('destroys the detector session after detecting', async () => {
      const session = {
        detect: vi.fn(async () => [{ detectedLanguage: 'en', confidence: 1 }]),
        destroy: vi.fn(),
      };
      const detector = makeDetector({ create: vi.fn(async () => session) });
      const api = createBrowserTranslationApi({ LanguageDetector: detector });

      await api.detect('hello');
      expect(session.destroy).toHaveBeenCalledTimes(1);
    });

    it('flags user activation required when detection creation rejects with InvalidStateError', async () => {
      const detector = makeDetector({ create: vi.fn().mockRejectedValue(invalidStateError()) });
      const api = createBrowserTranslationApi({ LanguageDetector: detector });

      await expect(api.detect('hello')).rejects.toBeInstanceOf(
        TranslationActivationRequiredError,
      );
    });

    it('rejects when detection returns no candidates', async () => {
      const detector = makeDetector({
        create: vi.fn(async () => ({
          detect: vi.fn(async () => []),
          destroy: vi.fn(),
        })),
      });
      const api = createBrowserTranslationApi({ LanguageDetector: detector });

      await expect(api.detect('???')).rejects.toThrow('no candidates');
    });
  });

  describe('language detection availability gate', () => {
    it('rejects with TranslationApiUnavailableError when availability is unavailable and never creates', async () => {
      const detector = makeDetector({
        availability: vi.fn(async () => 'unavailable' as ModelAvailability),
      });
      const api = createBrowserTranslationApi({ LanguageDetector: detector });

      await expect(api.detect('hello')).rejects.toBeInstanceOf(
        TranslationApiUnavailableError,
      );
      expect(detector.create).not.toHaveBeenCalled();
    });

    it('calls create() when the detector model is downloadable or downloading', async () => {
      const detector = makeDetector();
      detector.availability
        .mockResolvedValueOnce('downloadable')
        .mockResolvedValueOnce('downloading');
      const api = createBrowserTranslationApi({ LanguageDetector: detector });

      await expect(api.detect('hello')).resolves.toMatchObject({ language: 'en' });
      await expect(api.detect('hello')).resolves.toMatchObject({ language: 'en' });
      expect(detector.create).toHaveBeenCalledTimes(2);
    });

    it('detects even when the detector exposes no availability static (legacy)', async () => {
      const detector = makeDetector();
      delete (detector as { availability?: unknown }).availability;
      const api = createBrowserTranslationApi({ LanguageDetector: detector });

      await expect(api.detect('hello')).resolves.toMatchObject({ language: 'en' });
      expect(detector.create).toHaveBeenCalledTimes(1);
    });

    it('maps NotAllowedError from detection creation to activation-required', async () => {
      const detector = makeDetector({
        create: vi.fn().mockRejectedValue(new DOMException('blocked', 'NotAllowedError')),
      });
      const api = createBrowserTranslationApi({ LanguageDetector: detector });

      await expect(api.detect('hello')).rejects.toBeInstanceOf(
        TranslationActivationRequiredError,
      );
    });

    it('maps an activation rejection from detector availability to activation-required', async () => {
      const detector = makeDetector({
        availability: vi
          .fn()
          .mockRejectedValue(new DOMException('not enabled', 'InvalidStateError')),
      });
      const api = createBrowserTranslationApi({ LanguageDetector: detector });

      await expect(api.detect('hello')).rejects.toBeInstanceOf(
        TranslationActivationRequiredError,
      );
      expect(detector.create).not.toHaveBeenCalled();
    });

    it('maps NotAllowedError from detector availability to activation-required and never creates', async () => {
      const detector = makeDetector({
        availability: vi
          .fn()
          .mockRejectedValue(new DOMException('blocked by the user', 'NotAllowedError')),
      });
      const api = createBrowserTranslationApi({ LanguageDetector: detector });

      // Chrome 138 rejects LanguageDetector.availability() with
      // NotAllowedError when detection requires user permission: the adapter
      // classifies it as an activation requirement and must not attempt to
      // create a detector session.
      await expect(api.detect('hello')).rejects.toBeInstanceOf(
        TranslationActivationRequiredError,
      );
      expect(detector.create).not.toHaveBeenCalled();
    });

    it('maps an unknown availability rejection to TranslationApiUnavailableError', async () => {
      const detector = makeDetector({
        availability: vi.fn().mockRejectedValue(new Error('boom')),
      });
      const api = createBrowserTranslationApi({ LanguageDetector: detector });

      await expect(api.detect('hello')).rejects.toBeInstanceOf(
        TranslationApiUnavailableError,
      );
      expect(detector.create).not.toHaveBeenCalled();
    });
  });
});

// Type-level sanity: the returned adapter satisfies the required interface.
const _typeCheck: BrowserTranslationApi = createBrowserTranslationApi();
void _typeCheck;
