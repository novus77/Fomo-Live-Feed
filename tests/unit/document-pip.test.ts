import { describe, expect, it, vi } from 'vitest';

import {
  DocumentPipController,
  supportsDocumentPip,
  type DocumentPipControllerOptions,
  type DocumentPictureInPictureLike,
} from '../../src/floatpanel/document-pip';

interface PipWindowHarness {
  pipWindow: Window;
  pipDocument: Document;
  close: ReturnType<typeof vi.fn>;
  dispatchPageHide: () => void;
}

function createPipWindow(): PipWindowHarness {
  const pipDocument = document.implementation.createHTMLDocument();
  const events = new EventTarget();
  const close = vi.fn();
  const pipWindow = {
    document: pipDocument,
    closed: false,
    close,
    addEventListener: events.addEventListener.bind(events),
    removeEventListener: events.removeEventListener.bind(events),
  } as unknown as Window;

  return {
    pipWindow,
    pipDocument,
    close,
    dispatchPageHide: () => events.dispatchEvent(new Event('pagehide')),
  };
}

function createApi(
  requestWindow: DocumentPictureInPictureLike['requestWindow'],
): DocumentPictureInPictureLike {
  return { window: null, requestWindow };
}

describe('supportsDocumentPip', () => {
  it('returns false when the API is missing or incomplete', () => {
    expect(supportsDocumentPip(undefined)).toBe(false);
    expect(supportsDocumentPip(null)).toBe(false);
    expect(supportsDocumentPip({ window: null })).toBe(false);
    expect(supportsDocumentPip({ requestWindow: () => Promise.reject() })).toBe(
      false,
    );
  });
});

describe('DocumentPipController.activate', () => {
  it('requests a new window synchronously with the configured geometry', async () => {
    const { pipWindow } = createPipWindow();
    const requestWindow = vi.fn(() => Promise.resolve(pipWindow));
    const controller = new DocumentPipController(
      document,
      createApi(requestWindow),
      { width: 420, height: 680 },
    );

    const activation = controller.activate();

    expect(requestWindow).toHaveBeenCalledTimes(1);
    expect(requestWindow).toHaveBeenCalledWith({
      width: 420,
      height: 680,
      disallowReturnToOpener: false,
    });
    await expect(activation).resolves.toMatchObject({ ok: true, reused: false });
  });

  it('coalesces concurrent activations and reuses the live window', async () => {
    const { pipWindow } = createPipWindow();
    let resolveRequest: ((value: Window) => void) | undefined;
    const pending = new Promise<Window>((resolve) => {
      resolveRequest = resolve;
    });
    const requestWindow = vi.fn(() => pending);
    const controller = new DocumentPipController(
      document,
      createApi(requestWindow),
      { width: 400, height: 600 },
    );

    const first = controller.activate();
    const concurrent = controller.activate();
    expect(concurrent).toBe(first);
    expect(requestWindow).toHaveBeenCalledTimes(1);

    resolveRequest?.(pipWindow);
    await expect(first).resolves.toEqual({ ok: true, pipWindow, reused: false });
    await expect(controller.activate()).resolves.toEqual({
      ok: true,
      pipWindow,
      reused: true,
    });
    expect(requestWindow).toHaveBeenCalledTimes(1);
  });

  it('reuses in-flight activation before an API window exposed synchronously', async () => {
    const { pipWindow } = createPipWindow();
    let apiWindow: Window | null = null;
    let releaseMount: (() => void) | undefined;
    const mountGate = new Promise<void>((resolve) => {
      releaseMount = resolve;
    });
    const api: DocumentPictureInPictureLike = {
      get window() {
        return apiWindow;
      },
      requestWindow: vi.fn(() => {
        apiWindow = pipWindow;
        return Promise.resolve(pipWindow);
      }),
    };
    const controller = new DocumentPipController(document, api, {
      width: 400,
      height: 600,
      mount: () => mountGate,
    });

    const first = controller.activate();
    const concurrent = controller.activate();

    expect(concurrent).toBe(first);
    releaseMount?.();
    await expect(concurrent).resolves.toEqual({
      ok: true,
      pipWindow,
      reused: false,
    });
  });

  it('clones only inline and same-origin packaged styles into the PiP document', async () => {
    const host = document.implementation.createHTMLDocument();
    const base = host.createElement('base');
    base.href = 'chrome-extension://extension-id/sidepanel.html';
    host.head.append(base);

    const packagedLink = host.createElement('link');
    packagedLink.rel = 'stylesheet';
    packagedLink.href = 'styles/app.css';
    const externalLink = host.createElement('link');
    externalLink.rel = 'stylesheet';
    externalLink.href = 'https://cdn.example.com/app.css';
    const icon = host.createElement('link');
    icon.rel = 'icon';
    icon.href = 'icon.png';
    const style = host.createElement('style');
    style.textContent = '.event { color: red; }';
    const script = host.createElement('script');
    script.textContent = 'throw new Error("must not copy")';
    host.head.append(packagedLink, externalLink, icon, style, script);

    const { pipWindow, pipDocument } = createPipWindow();
    const controller = new DocumentPipController(
      host,
      createApi(() => Promise.resolve(pipWindow)),
      { width: 400, height: 600 },
    );

    await controller.activate();

    const copiedLinks = [...pipDocument.head.querySelectorAll('link')];
    expect(copiedLinks).toHaveLength(1);
    expect(copiedLinks[0]).not.toBe(packagedLink);
    expect(copiedLinks[0]?.href).toBe(packagedLink.href);
    const copiedStyle = pipDocument.head.querySelector('style');
    expect(copiedStyle).not.toBe(style);
    expect(copiedStyle?.textContent).toBe(style.textContent);
    expect(pipDocument.head.querySelector('script')).toBeNull();
  });

  it('preserves the host order of interleaved eligible style nodes', async () => {
    const host = document.implementation.createHTMLDocument();
    const base = host.createElement('base');
    base.href = 'chrome-extension://extension-id/sidepanel.html';
    const firstStyle = host.createElement('style');
    firstStyle.dataset.order = 'first';
    const packagedLink = host.createElement('link');
    packagedLink.rel = 'stylesheet';
    packagedLink.href = 'styles/app.css';
    packagedLink.dataset.order = 'second';
    const externalLink = host.createElement('link');
    externalLink.rel = 'stylesheet';
    externalLink.href = 'https://cdn.example.com/app.css';
    externalLink.dataset.order = 'filtered';
    const lastStyle = host.createElement('style');
    lastStyle.dataset.order = 'third';
    host.head.append(
      base,
      firstStyle,
      packagedLink,
      externalLink,
      lastStyle,
    );
    const { pipWindow, pipDocument } = createPipWindow();
    const controller = new DocumentPipController(
      host,
      createApi(() => Promise.resolve(pipWindow)),
      { width: 400, height: 600 },
    );

    await controller.activate();

    expect(
      [...pipDocument.head.querySelectorAll('style, link')].map(
        (node) => (node as HTMLElement).dataset.order,
      ),
    ).toEqual(['first', 'second', 'third']);
  });

  it('ignores stylesheet links whose URL cannot be parsed', async () => {
    const host = document.implementation.createHTMLDocument();
    const link = host.createElement('link');
    link.rel = 'stylesheet';
    link.setAttribute('href', 'http://[');
    host.head.append(link);
    const { pipWindow, pipDocument } = createPipWindow();
    const controller = new DocumentPipController(
      host,
      createApi(() => Promise.resolve(pipWindow)),
      { width: 400, height: 600 },
    );

    await expect(controller.activate()).resolves.toMatchObject({ ok: true });
    expect(pipDocument.head.querySelector('link')).toBeNull();
  });

  it('configures the PiP document shell and creates an empty root', async () => {
    const { pipWindow, pipDocument } = createPipWindow();
    const controller = new DocumentPipController(
      document,
      createApi(() => Promise.resolve(pipWindow)),
      {
        width: 400,
        height: 600,
        title: 'Fomo Feed',
        lang: 'zh-CN',
        colorScheme: 'dark',
        bodyClass: 'floatpanel-body',
        rootId: 'floatpanel-root',
      },
    );

    await controller.activate();

    expect(pipDocument.title).toBe('Fomo Feed');
    expect(pipDocument.documentElement.lang).toBe('zh-CN');
    expect(pipDocument.documentElement.style.colorScheme).toBe('dark');
    expect(pipDocument.body.className).toBe('floatpanel-body');
    const root = pipDocument.getElementById('floatpanel-root');
    expect(root).not.toBeNull();
    expect(root?.childNodes).toHaveLength(0);
    expect(pipDocument.body.children).toHaveLength(1);
  });

  it('reports pagehide once per window and allows a fresh activation', async () => {
    const firstWindow = createPipWindow();
    const secondWindow = createPipWindow();
    const requestWindow = vi
      .fn<DocumentPictureInPictureLike['requestWindow']>()
      .mockResolvedValueOnce(firstWindow.pipWindow)
      .mockResolvedValueOnce(secondWindow.pipWindow);
    const onClose = vi.fn();
    const controller = new DocumentPipController(
      document,
      createApi(requestWindow),
      { width: 400, height: 600, onClose },
    );
    await controller.activate();

    firstWindow.dispatchPageHide();
    firstWindow.dispatchPageHide();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith(firstWindow.pipWindow);

    await expect(controller.activate()).resolves.toEqual({
      ok: true,
      pipWindow: secondWindow.pipWindow,
      reused: false,
    });
    expect(requestWindow).toHaveBeenCalledTimes(2);
  });

  it('treats pagehide during mount as failure and remains retryable', async () => {
    const firstWindow = createPipWindow();
    const secondWindow = createPipWindow();
    let releaseMount: (() => void) | undefined;
    const mountGate = new Promise<void>((resolve) => {
      releaseMount = resolve;
    });
    const requestWindow = vi
      .fn<DocumentPictureInPictureLike['requestWindow']>()
      .mockResolvedValueOnce(firstWindow.pipWindow)
      .mockResolvedValueOnce(secondWindow.pipWindow);
    const onClose = vi.fn(() => {
      throw new Error('consumer close callback failed');
    });
    const mount = vi.fn(() =>
      mount.mock.calls.length === 1 ? mountGate : undefined,
    );
    const controller = new DocumentPipController(
      document,
      createApi(requestWindow),
      { width: 400, height: 600, mount, onClose },
    );

    const firstActivation = controller.activate();
    await vi.waitFor(() => expect(mount).toHaveBeenCalledTimes(1));
    firstWindow.dispatchPageHide();
    firstWindow.dispatchPageHide();
    releaseMount?.();

    await expect(firstActivation).resolves.toEqual({
      ok: false,
      reason: 'mount-failed',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    await expect(controller.activate()).resolves.toEqual({
      ok: true,
      pipWindow: secondWindow.pipWindow,
      reused: false,
    });
    expect(requestWindow).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a stale API window after its pagehide event', async () => {
    const firstWindow = createPipWindow();
    const secondWindow = createPipWindow();
    const requestWindow = vi.fn(() => Promise.resolve(secondWindow.pipWindow));
    const api: DocumentPictureInPictureLike = {
      window: firstWindow.pipWindow,
      requestWindow,
    };
    const controller = new DocumentPipController(document, api, {
      width: 400,
      height: 600,
    });

    await expect(controller.activate()).resolves.toEqual({
      ok: true,
      pipWindow: firstWindow.pipWindow,
      reused: true,
    });
    firstWindow.dispatchPageHide();

    await expect(controller.activate()).resolves.toEqual({
      ok: true,
      pipWindow: secondWindow.pipWindow,
      reused: false,
    });
    expect(requestWindow).toHaveBeenCalledTimes(1);
  });

  it('returns unsupported without requesting a window', async () => {
    const controller = new DocumentPipController(document, undefined, {
      width: 400,
      height: 600,
    });

    await expect(controller.activate()).resolves.toEqual({
      ok: false,
      reason: 'unsupported',
    });
  });

  it('maps request rejection to request-rejected', async () => {
    const controller = new DocumentPipController(
      document,
      createApi(() => Promise.reject(new Error('denied'))),
      { width: 400, height: 600 },
    );

    await expect(controller.activate()).resolves.toEqual({
      ok: false,
      reason: 'request-rejected',
    });
  });

  it('contains onError failure after a synchronous request error and retries', async () => {
    const { pipWindow } = createPipWindow();
    const requestWindow = vi
      .fn<DocumentPictureInPictureLike['requestWindow']>()
      .mockImplementationOnce(() => {
        throw new Error('sync request failure');
      })
      .mockResolvedValueOnce(pipWindow);
    const controller = new DocumentPipController(
      document,
      createApi(requestWindow),
      {
        width: 400,
        height: 600,
        onError: () => {
          throw new Error('consumer error callback failed');
        },
      },
    );

    await expect(controller.activate()).resolves.toEqual({
      ok: false,
      reason: 'request-rejected',
    });
    await expect(controller.activate()).resolves.toEqual({
      ok: true,
      pipWindow,
      reused: false,
    });
  });

  it('contains onError failure after async rejection and clears in-flight', async () => {
    const { pipWindow } = createPipWindow();
    const requestWindow = vi
      .fn<DocumentPictureInPictureLike['requestWindow']>()
      .mockRejectedValueOnce(new Error('async request failure'))
      .mockResolvedValueOnce(pipWindow);
    const controller = new DocumentPipController(
      document,
      createApi(requestWindow),
      {
        width: 400,
        height: 600,
        onError: () => {
          throw new Error('consumer error callback failed');
        },
      },
    );

    await expect(controller.activate()).resolves.toEqual({
      ok: false,
      reason: 'request-rejected',
    });
    await expect(controller.activate()).resolves.toEqual({
      ok: true,
      pipWindow,
      reused: false,
    });
    expect(requestWindow).toHaveBeenCalledTimes(2);
  });

  it('contains onError failure after mount failure and clears in-flight', async () => {
    const firstWindow = createPipWindow();
    const secondWindow = createPipWindow();
    const requestWindow = vi
      .fn<DocumentPictureInPictureLike['requestWindow']>()
      .mockResolvedValueOnce(firstWindow.pipWindow)
      .mockResolvedValueOnce(secondWindow.pipWindow);
    const mount = vi
      .fn<NonNullable<DocumentPipControllerOptions['mount']>>()
      .mockRejectedValueOnce(new Error('mount failure'))
      .mockResolvedValueOnce(undefined);
    const controller = new DocumentPipController(
      document,
      createApi(requestWindow),
      {
        width: 400,
        height: 600,
        mount,
        onError: () => {
          throw new Error('consumer error callback failed');
        },
      },
    );

    await expect(controller.activate()).resolves.toEqual({
      ok: false,
      reason: 'mount-failed',
    });
    await expect(controller.activate()).resolves.toEqual({
      ok: true,
      pipWindow: secondWindow.pipWindow,
      reused: false,
    });
    expect(firstWindow.close).toHaveBeenCalledTimes(1);
    expect(requestWindow).toHaveBeenCalledTimes(2);
  });

  it('closes a partial window and reports mount-failed when setup fails', async () => {
    const { pipWindow, close } = createPipWindow();
    const onError = vi.fn();
    const controller = new DocumentPipController(
      document,
      createApi(() => Promise.resolve(pipWindow)),
      {
        width: 400,
        height: 600,
        onError,
        mount: () => {
          throw new Error('mount failed');
        },
      },
    );

    await expect(controller.activate()).resolves.toEqual({
      ok: false,
      reason: 'mount-failed',
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith('mount-failed', expect.any(Error));
  });
});
