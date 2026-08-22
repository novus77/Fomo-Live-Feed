/**
 * React binding for the on-device opinion translator (Fomo feed recovery
 * plan, Task 7 foundation).
 *
 * - Normally the coordinator is created once per mount and destroyed on
 *   unmount, which releases its translator sessions (requirement: destroy
 *   sessions on provider unmount). `api` and `browserLanguage` are read at
 *   mount time and must be stable references; only `preferences` is live.
 * - The Side Panel may pass ONE shared coordinator (plan Task 7, session
 *   leak fix): every thesis card then uses the same coordinator and never
 *   destroys it on unmount. The panel root owns that coordinator and
 *   destroys it only when the panel unmounts, so N cards never hold N live
 *   translator sessions.
 * - `translate(text)` always runs under the LATEST preferences (kept in a
 *   ref). A preference change re-evaluates the last requested text, and a
 *   generation counter guarantees latest-wins: a stale in-flight response can
 *   never overwrite the result of a newer request.
 * - When translation is disabled the current result is cleared and in-flight
 *   work is invalidated; nothing is shown as translated.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { BrowserTranslationApi } from './browser-translation';
import {
  OpinionTranslationCoordinator,
  type OpinionTranslationDeps,
  type OpinionTranslationResult,
} from './opinion-translation';

export interface OpinionTranslationPreferences {
  enabled: boolean;
  /** Explicit target base tag; omit for `auto` (browser language). */
  target?: string;
}

export interface UseOpinionTranslationOptions {
  api: BrowserTranslationApi;
  /** Reads the user's language for `auto` (e.g. `() => navigator.language`). */
  browserLanguage: () => string;
  /** Live preferences; changing this object re-evaluates the current text. */
  preferences: OpinionTranslationPreferences;
  maxSourceLength?: number;
  maxCacheEntries?: number;
  /**
   * The side panel's shared coordinator (ONE per panel). When provided the
   * hook uses it as-is and never destroys it on unmount; the panel root owns
   * it and destroys it only when the panel unmounts. When omitted the hook
   * creates and owns its own coordinator for its own lifecycle.
   */
  coordinator?: OpinionTranslationCoordinator;
}

export type OpinionTranslationHookStatus = 'idle' | 'translating' | 'ready' | 'error';

export interface OpinionTranslationHookState {
  result: OpinionTranslationResult | null;
  status: OpinionTranslationHookStatus;
  /** Set only when the coordinator itself failed unexpectedly. */
  error: string | null;
  translate(text: string): void;
  clear(): void;
}

export function useOpinionTranslation(
  options: UseOpinionTranslationOptions,
): OpinionTranslationHookState {
  const externalCoordinator = options.coordinator;
  const coordinatorRef = useRef<OpinionTranslationCoordinator | null>(null);
  if (coordinatorRef.current === null && externalCoordinator === undefined) {
    const deps: OpinionTranslationDeps = {
      api: options.api,
      browserLanguage: options.browserLanguage,
    };
    if (options.maxSourceLength !== undefined) {
      deps.maxSourceLength = options.maxSourceLength;
    }
    if (options.maxCacheEntries !== undefined) {
      deps.maxCacheEntries = options.maxCacheEntries;
    }
    coordinatorRef.current = new OpinionTranslationCoordinator(deps);
  }
  const coordinator = externalCoordinator ?? coordinatorRef.current!;

  const prefsRef = useRef(options.preferences);
  const lastTextRef = useRef<string | null>(null);
  const generationRef = useRef(0);

  const [result, setResult] = useState<OpinionTranslationResult | null>(null);
  const [status, setStatus] = useState<OpinionTranslationHookStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  // Destroy the coordinator (and its translator sessions) on unmount. Only an
  // internally-owned coordinator is destroyed here: a shared side-panel
  // coordinator must outlive individual cards and is destroyed by the panel
  // root. The ref is nulled so a StrictMode remount builds a fresh
  // coordinator.
  useEffect(() => {
    return () => {
      coordinatorRef.current?.destroy();
      coordinatorRef.current = null;
    };
  }, []);

  const translate = useCallback(
    (text: string) => {
      lastTextRef.current = text;
      const generation = ++generationRef.current;
      const prefs = prefsRef.current;
      setError(null);

      if (!prefs.enabled) {
        setResult(null);
        setStatus('idle');
        return;
      }

      setStatus('translating');
      const request = prefs.target === undefined ? {} : { target: prefs.target };

      void coordinator
        .translate(text, request)
        .then((next) => {
          if (generation !== generationRef.current) return;
          setResult(next);
          setStatus('ready');
        })
        .catch((err: unknown) => {
          if (generation !== generationRef.current) return;
          setResult(null);
          setError(err instanceof Error ? err.message : String(err));
          setStatus('error');
        });
    },
    [coordinator],
  );

  // Keep the latest preferences live and re-evaluate the current text when
  // they change. Disabling clears the result and invalidates in-flight work.
  useEffect(() => {
    prefsRef.current = options.preferences;
    const last = lastTextRef.current;
    if (last === null) return;

    if (!options.preferences.enabled) {
      generationRef.current += 1;
      setResult(null);
      setError(null);
      setStatus('idle');
      return;
    }

    translate(last);
  }, [options.preferences, translate]);

  const clear = useCallback(() => {
    lastTextRef.current = null;
    generationRef.current += 1;
    setResult(null);
    setError(null);
    setStatus('idle');
  }, []);

  return { result, status, error, translate, clear };
}
