import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { BrowserTranslationApi } from '../../src/translation/browser-translation';
import { OpinionTranslationCoordinator } from '../../src/translation/opinion-translation';
import {
  useOpinionTranslation,
  type OpinionTranslationPreferences,
} from '../../src/translation/use-opinion-translation';

type MockSession = {
  translate: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

function makeSession(source: string, target: string): MockSession {
  return {
    translate: vi.fn(async (text: string) => `[${source}->${target}] ${text}`),
    destroy: vi.fn(),
  };
}

function makeApi() {
  const sessions: Array<{ session: MockSession; source: string; target: string }> = [];

  const detect = vi.fn(async () => ({ language: 'es', confidence: 0.99 }));
  const availability = vi.fn(async (_source: string, _target: string) => 'available' as const);
  const create = vi.fn(async (source: string, target: string) => {
    const session = makeSession(source, target);
    sessions.push({ session, source, target });
    return session;
  });

  const api = {
    detect,
    availability,
    create,
  } as unknown as BrowserTranslationApi & {
    detect: typeof detect;
    availability: typeof availability;
    create: typeof create;
  };

  return { api, sessions };
}

function renderWithPreferences(preferences: OpinionTranslationPreferences, api: BrowserTranslationApi) {
  return renderHook(
    (props: { preferences: OpinionTranslationPreferences }) =>
      useOpinionTranslation({ api, browserLanguage: () => 'en', preferences: props.preferences }),
    { initialProps: { preferences } },
  );
}

describe('useOpinionTranslation', () => {
  it('stays idle and never translates while disabled', () => {
    const { api } = makeApi();
    const { result } = renderWithPreferences({ enabled: false }, api);

    expect(result.current.status).toBe('idle');
    expect(result.current.result).toBeNull();

    act(() => {
      result.current.translate('hello');
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.result).toBeNull();
    expect(api.detect).not.toHaveBeenCalled();
  });

  it('translates the requested text to a ready result', async () => {
    const { api } = makeApi();
    const { result } = renderWithPreferences({ enabled: true }, api);

    act(() => {
      result.current.translate('hello');
    });
    expect(result.current.status).toBe('translating');

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.result).toEqual({
      status: 'translated',
      original: 'hello',
      translated: '[es->en] hello',
    });
  });

  it('re-evaluates the current text when preferences change (latest wins)', async () => {
    const { api } = makeApi();
    const { result, rerender } = renderWithPreferences({ enabled: true }, api);

    act(() => {
      result.current.translate('hello');
    });
    await waitFor(() =>
      expect(result.current.result).toEqual(expect.objectContaining({ translated: '[es->en] hello' })),
    );

    rerender({ preferences: { enabled: true, target: 'fr' } });
    await waitFor(() =>
      expect(result.current.result).toEqual(expect.objectContaining({ translated: '[es->fr] hello' })),
    );
  });

  it('clears the result and invalidates in-flight work when disabled', async () => {
    let resolveTranslate!: (value: string) => void;
    const gate = new Promise<string>((resolve) => {
      resolveTranslate = resolve;
    });
    const session = makeSession('es', 'en');
    session.translate.mockImplementation(() => gate);
    const { api } = makeApi();
    api.create.mockImplementation(async () => session);
    const { result, rerender } = renderWithPreferences({ enabled: true }, api);

    act(() => {
      result.current.translate('hello');
    });
    expect(result.current.status).toBe('translating');

    rerender({ preferences: { enabled: false } });
    expect(result.current.status).toBe('idle');
    expect(result.current.result).toBeNull();

    // The stale in-flight response must not resurrect a result.
    await act(async () => {
      resolveTranslate('[es->en] hello');
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.result).toBeNull();
  });

  it('ignores stale in-flight results when a newer request lands first', async () => {
    let resolveHello!: (value: string) => void;
    const session = makeSession('es', 'en');
    session.translate.mockImplementation((text: string) => {
      if (text === 'hello') {
        return new Promise<string>((resolve) => {
          resolveHello = resolve;
        });
      }
      return Promise.resolve(`[es->en] ${text}`);
    });
    const { api } = makeApi();
    api.create.mockImplementation(async () => session);
    const { result } = renderWithPreferences({ enabled: true }, api);

    act(() => {
      result.current.translate('hello'); // slow
    });
    act(() => {
      result.current.translate('bonjour'); // fast
    });

    await waitFor(() =>
      expect(result.current.result).toEqual(
        expect.objectContaining({ translated: '[es->en] bonjour' }),
      ),
    );

    await act(async () => {
      resolveHello('[es->en] hello');
    });
    expect(result.current.result).toEqual(
      expect.objectContaining({ translated: '[es->en] bonjour' }),
    );
  });

  it('clears the current result', async () => {
    const { api } = makeApi();
    const { result } = renderWithPreferences({ enabled: true }, api);

    act(() => {
      result.current.translate('hello');
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    act(() => {
      result.current.clear();
    });
    expect(result.current.status).toBe('idle');
    expect(result.current.result).toBeNull();
  });

  it('destroys the coordinator and its sessions on unmount', async () => {
    const { api, sessions } = makeApi();
    const { result, unmount } = renderWithPreferences({ enabled: true }, api);

    act(() => {
      result.current.translate('hello');
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));

    expect(sessions).toHaveLength(1);
    const session = sessions[0]!.session;
    expect(session.destroy).not.toHaveBeenCalled();

    unmount();
    expect(session.destroy).toHaveBeenCalledTimes(1);
  });

  it('uses a shared coordinator without destroying it on unmount', async () => {
    const { api, sessions } = makeApi();
    const coordinator = new OpinionTranslationCoordinator({
      api,
      browserLanguage: () => 'en',
    });
    const { result, unmount } = renderHook(() =>
      useOpinionTranslation({
        api,
        browserLanguage: () => 'en',
        preferences: { enabled: true },
        coordinator,
      }),
    );

    act(() => {
      result.current.translate('hello');
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(sessions).toHaveLength(1);

    const session = sessions[0]!.session;
    unmount();

    // The shared coordinator belongs to the side panel root: the consumer
    // unmount must NOT destroy its sessions.
    expect(session.destroy).not.toHaveBeenCalled();
    await expect(coordinator.translate('world')).resolves.toMatchObject({
      status: 'translated',
    });
  });
});
