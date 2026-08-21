/**
 * On-device translation adapters over Chrome 138's built-in AI
 * `Translator` / `LanguageDetector` globals (Fomo feed recovery plan, Task 7
 * foundation).
 *
 * Scope decisions:
 * - This module ONLY adapts the browser API. It performs no policy decisions
 *   (see `opinion-translation.ts` for the coordinator) and touches no
 *   `chrome.*` APIs: detection, translator sessions, texts, cache, and
 *   results all stay inside the Side Panel process.
 * - The browser API is reached through a dependency-injected environment, so
 *   unit tests can substitute fakes without touching `globalThis`. Feature
 *   detection is runtime type-guarding of the experimental globals;
 *   TypeScript never sees their global declarations.
 * - Chrome signals "the user must enable / download the model" by rejecting
 *   `create()` with an `InvalidStateError`, and "this language pair is not
 *   supported" with a `NotSupportedError`. Those browser-specific exception
 *   names are translated into typed errors here so the coordinator never has
 *   to know them.
 */

export type ModelAvailability =
  | 'available'
  | 'downloadable'
  | 'downloading'
  | 'unavailable';

/** A live translator session. Structurally identical to the required API. */
export interface TranslatorSession {
  translate(text: string): Promise<string>;
  destroy(): void;
}

export interface BrowserTranslationApi {
  detect(text: string): Promise<{ language: string; confidence: number }>;
  availability(sourceLanguage: string, targetLanguage: string): Promise<ModelAvailability>;
  create(sourceLanguage: string, targetLanguage: string): Promise<TranslatorSession>;
}

/** The API is not present in this browser at all (feature detection failed). */
export class TranslationApiUnavailableError extends Error {
  constructor(message = 'On-device translation is not available in this browser.') {
    super(message);
    this.name = 'TranslationApiUnavailableError';
  }
}

/**
 * The user must enable the feature / let the model download before the
 * translation can run (Chrome's `InvalidStateError` from `create()`).
 */
export class TranslationActivationRequiredError extends Error {
  constructor(message = 'On-device translation requires user activation.') {
    super(message);
    this.name = 'TranslationActivationRequiredError';
  }
}

/** The source/target language pair is not supported by the browser model. */
export class TranslationUnsupportedPairError extends Error {
  constructor(message = 'This language pair is not supported.') {
    super(message);
    this.name = 'TranslationUnsupportedPairError';
  }
}

export interface BrowserTranslationEnv {
  Translator?: unknown;
  LanguageDetector?: unknown;
}

/** Read the experimental globals without assuming they exist at compile time. */
export function readBrowserTranslationEnv(
  globalObject: typeof globalThis = globalThis,
): BrowserTranslationEnv {
  const host = globalObject as typeof globalThis & BrowserTranslationEnv;
  return {
    Translator: host.Translator,
    LanguageDetector: host.LanguageDetector,
  };
}

interface DetectionCandidate {
  confidence: number;
  detectedLanguage?: unknown;
  language?: unknown;
}

interface DetectorSession {
  detect(text: string): Promise<DetectionCandidate[]>;
  destroy(): void;
}

interface TranslatorCtor {
  create(options: { sourceLanguage: string; targetLanguage: string }): Promise<TranslatorSession>;
  availability?(options: { sourceLanguage: string; targetLanguage: string }): Promise<unknown>;
}

interface LanguageDetectorCtor {
  create(): Promise<DetectorSession>;
  availability?(): Promise<unknown>;
}

function isTranslatorCtor(value: unknown): value is TranslatorCtor {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as TranslatorCtor).create === 'function'
  );
}

function isLanguageDetectorCtor(value: unknown): value is LanguageDetectorCtor {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as LanguageDetectorCtor).create === 'function'
  );
}

function isDomException(error: unknown, name: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === name
  );
}

/**
 * Chrome's availability values; legacy origin-trial builds reported
 * `installed` instead of `available`. Anything unrecognized is treated as
 * `unavailable` so the coordinator never sees an unexpected state.
 */
function normalizeAvailability(value: unknown): ModelAvailability {
  switch (value) {
    case 'available':
    case 'installed':
      return 'available';
    case 'downloadable':
      return 'downloadable';
    case 'downloading':
      return 'downloading';
    default:
      return 'unavailable';
  }
}

function classifyTranslatorCreateError(error: unknown): unknown {
  if (isDomException(error, 'InvalidStateError')) {
    return new TranslationActivationRequiredError(
      'The translator model needs to be enabled or downloaded by the user.',
    );
  }
  if (isDomException(error, 'NotSupportedError')) {
    return new TranslationUnsupportedPairError();
  }
  return error;
}

function classifyDetectorCreateError(error: unknown): unknown {
  if (isDomException(error, 'InvalidStateError') || isDomException(error, 'NotAllowedError')) {
    return new TranslationActivationRequiredError(
      'Language detection needs to be enabled or downloaded by the user.',
    );
  }
  if (isDomException(error, 'NotSupportedError')) {
    return new TranslationApiUnavailableError('Language detection is not supported.');
  }
  return error;
}

/**
 * Feature-detect the globals and build the adapter. When a global is missing
 * the adapter degrades gracefully: `availability` resolves to `'unavailable'`
 * and `detect`/`create` reject with `TranslationApiUnavailableError`, so the
 * coordinator maps the situation to a clean `unavailable` result.
 */
export function createBrowserTranslationApi(
  env: BrowserTranslationEnv = readBrowserTranslationEnv(),
): BrowserTranslationApi {
  const translator = isTranslatorCtor(env.Translator) ? env.Translator : undefined;
  const detector = isLanguageDetectorCtor(env.LanguageDetector)
    ? env.LanguageDetector
    : undefined;

  return {
    async detect(text: string): Promise<{ language: string; confidence: number }> {
      if (detector === undefined) {
        throw new TranslationApiUnavailableError(
          'LanguageDetector is not available in this browser.',
        );
      }

      // Check the detector model's availability before creating a session.
      // 'unavailable' means detection cannot run at all; 'downloadable' and
      // 'downloading' still proceed to create(), which triggers or awaits
      // the model download and either returns a session or rejects with an
      // activation error. Legacy detectors without an availability static
      // skip the check and go straight to create().
      if (typeof detector.availability === 'function') {
        let state: unknown;
        try {
          state = await detector.availability();
        } catch (error) {
          if (
            isDomException(error, 'NotAllowedError') ||
            isDomException(error, 'InvalidStateError')
          ) {
            throw new TranslationActivationRequiredError(
              'Language detection needs to be enabled by the user.',
            );
          }
          throw new TranslationApiUnavailableError(
            'Language detection is not available in this browser.',
          );
        }
        if (normalizeAvailability(state) === 'unavailable') {
          throw new TranslationApiUnavailableError(
            'Language detection is not available in this browser.',
          );
        }
      }

      let session: DetectorSession;
      try {
        session = await detector.create();
      } catch (error) {
        throw classifyDetectorCreateError(error);
      }

      try {
        const candidates = await session.detect(text);
        const best = [...candidates].sort((a, b) => b.confidence - a.confidence)[0];
        if (best === undefined) {
          throw new Error('Language detection returned no candidates.');
        }
        const language = String(best.detectedLanguage ?? best.language ?? '');
        if (language.length === 0) {
          throw new Error('Language detection returned a candidate without a language.');
        }
        return { language, confidence: best.confidence };
      } finally {
        session.destroy();
      }
    },

    async availability(sourceLanguage: string, targetLanguage: string): Promise<ModelAvailability> {
      if (translator === undefined || typeof translator.availability !== 'function') {
        return 'unavailable';
      }
      try {
        return normalizeAvailability(
          await translator.availability({ sourceLanguage, targetLanguage }),
        );
      } catch {
        return 'unavailable';
      }
    },

    async create(sourceLanguage: string, targetLanguage: string): Promise<TranslatorSession> {
      if (translator === undefined) {
        throw new TranslationApiUnavailableError('Translator is not available in this browser.');
      }

      let session: TranslatorSession;
      try {
        session = await translator.create({ sourceLanguage, targetLanguage });
      } catch (error) {
        throw classifyTranslatorCreateError(error);
      }

      return {
        translate: (text: string) => session.translate(text),
        destroy: () => session.destroy(),
      };
    },
  };
}
