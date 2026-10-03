import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, type LocalSettingsV6 } from '../../src/domain/settings';
import { useSurfaceTheme } from '../../src/floatpanel/use-surface-theme';
import type { SidePanelDependencies } from '../../src/sidepanel/SidePanelApp';
import { LocalPreferences, SETTINGS_STORAGE_KEY } from '../../src/storage/local-preferences';

const deferredSettings = () => {
  let resolve!: (settings: LocalSettingsV6) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<LocalSettingsV6>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

const createHarness = () => {
  const listeners = new Set<(changes: Record<string, unknown>, area: string) => void>();
  const local = { get: async () => ({}), set: async () => {} };
  const preferences = new LocalPreferences(local);
  const read = vi.spyOn(preferences, 'getSettings').mockResolvedValue(DEFAULT_SETTINGS);
  const deps: SidePanelDependencies = {
    preferences,
    storage: {
      local,
      onChanged: {
        addListener: (listener) => { listeners.add(listener); },
        removeListener: (listener) => { listeners.delete(listener); },
      },
    },
    runtime: {
      sendMessage: async () => ({}),
      onMessage: { addListener() {}, removeListener() {} },
    },
    now: () => 0,
  };
  return {
    deps,
    read,
    listenerCount: () => listeners.size,
    emit(changes: Record<string, unknown>, area = 'local') {
      for (const listener of [...listeners]) listener(changes, area);
    },
  };
};

describe('useSurfaceTheme', () => {
  it('keeps the newest cross-surface theme when an older read completes last', async () => {
    const harness = createHarness();
    const older = deferredSettings();
    const newer = deferredSettings();
    harness.read.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const { result } = renderHook(() => useSurfaceTheme(harness.deps));

    harness.emit({ [SETTINGS_STORAGE_KEY]: {} });
    await act(async () => { newer.resolve({ ...DEFAULT_SETTINGS, uiTheme: 'light' }); });
    expect(result.current).toBe('light');
    await act(async () => { older.resolve({ ...DEFAULT_SETTINGS, uiTheme: 'dark' }); });
    expect(result.current).toBe('light');
    expect(harness.read).toHaveBeenCalledTimes(2);
  });

  it('retains the committed theme when the latest read fails and an older success follows', async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useSurfaceTheme(harness.deps));
    await act(async () => {});
    expect(result.current).toBe('dark');

    const older = deferredSettings();
    const newer = deferredSettings();
    harness.read.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    harness.emit({ [SETTINGS_STORAGE_KEY]: {} });
    harness.emit({ [SETTINGS_STORAGE_KEY]: {} });
    await act(async () => { newer.reject(new Error('latest read failed')); });
    expect(result.current).toBe('dark');
    await act(async () => { older.resolve({ ...DEFAULT_SETTINGS, uiTheme: 'light' }); });
    expect(result.current).toBe('dark');
  });

  it('ignores unrelated keys and non-local storage changes', async () => {
    const harness = createHarness();
    const { result } = renderHook(() => useSurfaceTheme(harness.deps));
    await act(async () => {});

    harness.emit({ other: {} });
    harness.emit({ [SETTINGS_STORAGE_KEY]: {} }, 'sync');
    expect(harness.read).toHaveBeenCalledTimes(1);
    expect(result.current).toBe('dark');
  });

  it('ignores replaced readers and removes listeners on replacement and unmount', async () => {
    const first = createHarness();
    const second = createHarness();
    const oldRead = deferredSettings();
    first.read.mockReturnValueOnce(oldRead.promise);
    second.read.mockResolvedValue({ ...DEFAULT_SETTINGS, uiTheme: 'light' });
    const view = renderHook(({ deps }) => useSurfaceTheme(deps), {
      initialProps: { deps: first.deps },
    });

    view.rerender({ deps: second.deps });
    await act(async () => {});
    expect(view.result.current).toBe('light');
    expect(first.listenerCount()).toBe(0);
    expect(second.listenerCount()).toBe(1);
    first.emit({ [SETTINGS_STORAGE_KEY]: {} });
    expect(first.read).toHaveBeenCalledTimes(1);
    await act(async () => { oldRead.resolve({ ...DEFAULT_SETTINGS, uiTheme: 'dark' }); });
    expect(view.result.current).toBe('light');

    const pending = deferredSettings();
    second.read.mockReturnValueOnce(pending.promise);
    second.emit({ [SETTINGS_STORAGE_KEY]: {} });
    view.unmount();
    expect(second.listenerCount()).toBe(0);
    second.emit({ [SETTINGS_STORAGE_KEY]: {} });
    expect(second.read).toHaveBeenCalledTimes(2);
    await act(async () => { pending.resolve({ ...DEFAULT_SETTINGS, uiTheme: 'dark' }); });
    expect(view.result.current).toBe('light');
  });
});
