import { describe, expect, it, vi } from 'vitest';

import type { BrowserTranslationApi } from '../../src/translation/browser-translation';
import { OpinionTranslationCoordinator } from '../../src/translation/opinion-translation';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}

function fixture() {
  const gate = deferred<string>();
  const session = { translate: vi.fn((_text: string) => gate.promise), destroy: vi.fn() };
  const api: BrowserTranslationApi = {
    detect: vi.fn(async () => ({ language: 'es', confidence: 1 })),
    availability: vi.fn(async () => 'available' as const),
    create: vi.fn(async () => session),
  };
  const coordinator = new OpinionTranslationCoordinator({
    api, browserLanguage: () => 'en', hashText: async (text) => text,
  });
  return { api, coordinator, gate, session };
}

describe('opinion translation scheduling', () => {
  it('bounds the entire pipeline and drains different texts in FIFO order', async () => {
    const { api, coordinator, gate, session } = fixture();
    const requests = Array.from({ length: 20 }, (_, index) => coordinator.translate(`text-${index}`));
    await vi.waitFor(() => expect(session.translate).toHaveBeenCalledTimes(2));
    expect(api.detect).toHaveBeenCalledTimes(2);
    expect(api.availability).toHaveBeenCalledTimes(2);
    gate.resolve('translated');
    expect((await Promise.all(requests)).every((result) => result.status === 'translated')).toBe(true);
    expect(vi.mocked(api.detect).mock.calls.map(([text]) => text)).toEqual(
      Array.from({ length: 20 }, (_, index) => `text-${index}`),
    );
    expect(api.create).toHaveBeenCalledTimes(1);
    coordinator.destroy();
  });

  it('removes cancelled queued work without touching the API', async () => {
    const { api, coordinator, gate, session } = fixture();
    const first = coordinator.translate('first');
    const second = coordinator.translate('second');
    await vi.waitFor(() => expect(session.translate).toHaveBeenCalledTimes(2));
    const controller = new AbortController();
    const queued = coordinator.translate('cancelled', { signal: controller.signal });
    const rejected = expect(queued).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    controller.abort();
    await rejected;
    gate.resolve('done');
    await Promise.all([first, second]);
    expect(api.detect).toHaveBeenCalledTimes(2);
    coordinator.destroy();
  });

  it('cancels one subscriber without cancelling a shared translation', async () => {
    const { api, coordinator, gate, session } = fixture();
    const controller = new AbortController();
    const cancelled = coordinator.translate('shared', { signal: controller.signal });
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    const retained = coordinator.translate('shared');
    await vi.waitFor(() => expect(session.translate).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    gate.resolve('done');
    const result = await retained;
    expect(result).toMatchObject({ status: 'translated', translated: 'done' });
    expect(await coordinator.translate('shared')).toBe(result);
    expect(api.detect).toHaveBeenCalledTimes(1);
    expect(session.destroy).not.toHaveBeenCalled();
    coordinator.destroy();
  });

  it('retains an abandoned native call slot until it settles and does not cache it', async () => {
    const { api, coordinator, gate, session } = fixture();
    const controller = new AbortController();
    const abandoned = coordinator.translate('abandoned', { signal: controller.signal });
    const rejected = expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
    const active = coordinator.translate('active');
    await vi.waitFor(() => expect(session.translate).toHaveBeenCalledTimes(2));
    controller.abort();
    await rejected;
    const queued = coordinator.translate('queued');
    await Promise.resolve();
    expect(api.detect).toHaveBeenCalledTimes(2);
    expect(session.destroy).not.toHaveBeenCalled();
    gate.resolve('done');
    await Promise.all([active, queued]);
    await coordinator.translate('abandoned');
    expect(api.detect).toHaveBeenCalledTimes(4);
    coordinator.destroy();
  });

  it('stops after detection when the final subscriber cancels', async () => {
    const { api, coordinator } = fixture();
    const detection = deferred<{ language: string; confidence: number }>();
    vi.mocked(api.detect).mockImplementation(() => detection.promise);
    const controller = new AbortController();
    const request = coordinator.translate('stale', { signal: controller.signal });
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(api.detect).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    detection.resolve({ language: 'es', confidence: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(api.availability).not.toHaveBeenCalled();
    expect(api.create).not.toHaveBeenCalled();
    coordinator.destroy();
  });

  it('does not start API work when destroyed during hashing', async () => {
    const { api } = fixture();
    const hash = deferred<string>();
    const coordinator = new OpinionTranslationCoordinator({
      api, browserLanguage: () => 'en', hashText: () => hash.promise,
    });
    const request = coordinator.translate('late');
    const rejected = expect(request).rejects.toThrow('destroyed');
    coordinator.destroy();
    hash.resolve('late');
    await rejected;
    expect(api.detect).not.toHaveBeenCalled();
  });

  it.each(['availability', 'create'] as const)('stops after cancelled %s without starting translation', async (stage) => {
    const { api, coordinator, session } = fixture();
    const gate = deferred<void>();
    if (stage === 'availability') {
      vi.mocked(api.availability).mockImplementation(async () => { await gate.promise; return 'available'; });
    } else {
      vi.mocked(api.create).mockImplementation(async () => { await gate.promise; return session; });
    }
    const controller = new AbortController();
    const request = coordinator.translate('stale', { signal: controller.signal });
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(api[stage]).toHaveBeenCalledTimes(1));
    controller.abort();
    await rejected;
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(session.translate).not.toHaveBeenCalled();
    if (stage === 'availability') expect(api.create).not.toHaveBeenCalled();
    coordinator.destroy();
  });

  it('does not remove a queued same-key replacement when an abandoned job finishes', async () => {
    const { api, coordinator, gate, session } = fixture();
    const otherGate = deferred<string>();
    session.translate.mockImplementation((text) => text === 'other' ? otherGate.promise : gate.promise);
    const controller = new AbortController();
    const abandoned = coordinator.translate('same', { signal: controller.signal });
    const rejected = expect(abandoned).rejects.toMatchObject({ name: 'AbortError' });
    const other = coordinator.translate('other');
    await vi.waitFor(() => expect(session.translate).toHaveBeenCalledTimes(2));
    controller.abort();
    await rejected;
    const replacement = coordinator.translate('same');
    const detectionGate = deferred<{ language: string; confidence: number }>();
    vi.mocked(api.detect).mockImplementation(() => detectionGate.promise);
    gate.resolve('old');
    await vi.waitFor(() => expect(api.detect).toHaveBeenCalledTimes(3));
    const joined = coordinator.translate('same');
    detectionGate.resolve({ language: 'es', confidence: 1 });
    expect(await joined).toBe(await replacement);
    expect(api.detect).toHaveBeenCalledTimes(3);
    otherGate.resolve('other');
    await other;
    coordinator.destroy();
  });

  it('settles queued requests on destroy without starting them or retrying active work', async () => {
    const { api, coordinator } = fixture();
    const detection = deferred<{ language: string; confidence: number }>();
    vi.mocked(api.detect).mockImplementation(() => detection.promise);
    const first = coordinator.translate('first');
    const second = coordinator.translate('second');
    const queued = coordinator.translate('queued');
    await vi.waitFor(() => expect(api.detect).toHaveBeenCalledTimes(2));
    coordinator.destroy();
    await expect(queued).resolves.toEqual({ status: 'failed', original: 'queued' });
    detection.resolve({ language: 'es', confidence: 1 });
    await Promise.all([first, second]);
    expect(api.detect).toHaveBeenCalledTimes(2);
    expect(api.availability).not.toHaveBeenCalled();
  });

  it('rejects pre-aborted and cancelled hashing requests before the API', async () => {
    const { api } = fixture();
    const hash = deferred<string>();
    const hashText = vi.fn(() => hash.promise);
    const coordinator = new OpinionTranslationCoordinator({ api, browserLanguage: () => 'en', hashText });
    const controller = new AbortController();
    const request = coordinator.translate('late', { signal: controller.signal });
    controller.abort();
    await expect(coordinator.translate('pre-aborted', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    const rejected = expect(request).rejects.toMatchObject({ name: 'AbortError' });
    hash.resolve('late');
    await rejected;
    expect(hashText).toHaveBeenCalledTimes(1);
    expect(api.detect).not.toHaveBeenCalled();
    coordinator.destroy();
  });

  it('preserves immediate user-gesture preparation while translation slots are occupied', async () => {
    const { api, coordinator, gate, session } = fixture();
    const first = coordinator.translate('first');
    const second = coordinator.translate('second');
    await vi.waitFor(() => expect(session.translate).toHaveBeenCalledTimes(2));
    const prepared = coordinator.prepare('fr', 'en');
    expect(api.create).toHaveBeenCalledWith('fr', 'en');
    await prepared;
    gate.resolve('done');
    await Promise.all([first, second]);
    coordinator.destroy();
  });

  it('drains the queue after a failed translation', async () => {
    const { coordinator, gate, session } = fixture();
    session.translate.mockImplementation((text) => text === 'bad' ? Promise.reject(new Error('failed')) : gate.promise);
    const requests = ['bad', 'second', 'third'].map((text) => coordinator.translate(text));
    await vi.waitFor(() => expect(session.translate).toHaveBeenCalledTimes(3));
    gate.resolve('done');
    expect((await Promise.all(requests)).map((result) => result.status)).toEqual(['failed', 'translated', 'translated']);
    coordinator.destroy();
  });
});
