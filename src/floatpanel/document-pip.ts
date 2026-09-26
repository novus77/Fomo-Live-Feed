export interface DocumentPictureInPictureLike {
  readonly window: Window | null;
  requestWindow(options: {
    width: number;
    height: number;
    disallowReturnToOpener?: boolean;
  }): Promise<Window>;
}

export type PipActivationResult =
  | { ok: true; pipWindow: Window; reused: boolean }
  | { ok: false; reason: 'unsupported' | 'request-rejected' | 'mount-failed' };

export interface DocumentPipControllerOptions {
  width: number;
  height: number;
  getGeometry?: () => { width: number; height: number };
  title?: string;
  lang?: string;
  colorScheme?: string;
  bodyClass?: string;
  rootId?: string;
  mount?: (root: HTMLElement, pipWindow: Window) => void | Promise<void>;
  onClose?: (pipWindow: Window) => void;
  onError?: (
    reason: Extract<PipActivationResult, { ok: false }>['reason'],
    error: unknown,
  ) => void;
}

export function supportsDocumentPip(
  api: unknown,
): api is DocumentPictureInPictureLike {
  return (
    typeof api === 'object' &&
    api !== null &&
    'window' in api &&
    'requestWindow' in api &&
    typeof api.requestWindow === 'function'
  );
}

export class DocumentPipController {
  private liveWindow: Window | null = null;
  private inFlight: Promise<PipActivationResult> | null = null;
  private readonly observedWindows = new WeakSet<Window>();
  private readonly hiddenWindows = new WeakSet<Window>();

  constructor(
    private readonly hostDocument: Document,
    private readonly api: DocumentPictureInPictureLike | null | undefined,
    private readonly options: DocumentPipControllerOptions,
  ) {}

  activate(): Promise<PipActivationResult> {
    if (this.inFlight !== null) {
      return this.inFlight;
    }

    if (!supportsDocumentPip(this.api)) {
      return Promise.resolve({ ok: false, reason: 'unsupported' });
    }

    const liveWindow = this.getLiveWindow();
    if (liveWindow !== null) {
      this.observePageHide(liveWindow);
      return Promise.resolve({ ok: true, pipWindow: liveWindow, reused: true });
    }

    let request: Promise<Window>;
    try {
      const geometry = this.options.getGeometry?.() ?? this.options;
      request = this.api.requestWindow({
        width: geometry.width,
        height: geometry.height,
        disallowReturnToOpener: false,
      });
    } catch (error) {
      this.reportError('request-rejected', error);
      return Promise.resolve({ ok: false, reason: 'request-rejected' });
    }

    this.inFlight = this.finishActivation(request);
    return this.inFlight;
  }

  private getLiveWindow(): Window | null {
    const candidate = this.liveWindow ?? this.api?.window ?? null;
    if (
      candidate === null ||
      candidate.closed ||
      this.hiddenWindows.has(candidate)
    ) {
      if (candidate === this.liveWindow) {
        this.liveWindow = null;
      }
      return null;
    }
    this.liveWindow = candidate;
    return candidate;
  }

  private async finishActivation(
    request: Promise<Window>,
  ): Promise<PipActivationResult> {
    try {
      let pipWindow: Window;
      try {
        pipWindow = await request;
      } catch (error) {
        this.reportError('request-rejected', error);
        return { ok: false, reason: 'request-rejected' };
      }

      try {
        this.observePageHide(pipWindow);
        this.ensureWindowActive(pipWindow);
        const root = this.setupDocument(pipWindow.document);
        this.ensureWindowActive(pipWindow);
        await this.options.mount?.(root, pipWindow);
        this.ensureWindowActive(pipWindow);
        this.liveWindow = pipWindow;
        return { ok: true, pipWindow, reused: false };
      } catch (error) {
        this.closeSafely(pipWindow);
        this.reportError('mount-failed', error);
        return { ok: false, reason: 'mount-failed' };
      }
    } finally {
      this.inFlight = null;
    }
  }

  private ensureWindowActive(pipWindow: Window): void {
    if (pipWindow.closed || this.hiddenWindows.has(pipWindow)) {
      throw new Error('Picture-in-Picture window closed during setup');
    }
  }

  private setupDocument(pipDocument: Document): HTMLElement {
    const styleNodes = this.hostDocument.head.querySelectorAll(
      'style, link[rel~="stylesheet"]',
    );
    for (const node of styleNodes) {
      if (node.tagName === 'STYLE') {
        pipDocument.head.append(node.cloneNode(true));
        continue;
      }

      const href = node.getAttribute('href');
      if (href === null) {
        continue;
      }

      const resolvedHref = this.resolveSameOriginHref(href);
      if (resolvedHref === null) {
        continue;
      }

      const clone = node.cloneNode(true) as HTMLLinkElement;
      clone.href = resolvedHref;
      pipDocument.head.append(clone);
    }

    pipDocument.title = this.options.title ?? this.hostDocument.title;
    pipDocument.documentElement.lang =
      this.options.lang ?? this.hostDocument.documentElement.lang;
    pipDocument.documentElement.style.colorScheme =
      this.options.colorScheme ?? this.hostDocument.documentElement.style.colorScheme;
    pipDocument.body.className = this.options.bodyClass ?? '';

    const root = pipDocument.createElement('div');
    root.id = this.options.rootId ?? 'root';
    pipDocument.body.replaceChildren(root);
    return root;
  }

  private resolveSameOriginHref(href: string): string | null {
    try {
      const hostUrl = new URL(this.hostDocument.baseURI);
      const stylesheetUrl = new URL(href, hostUrl);
      const sameOrigin =
        hostUrl.origin !== 'null'
          ? stylesheetUrl.origin === hostUrl.origin
          : stylesheetUrl.protocol === hostUrl.protocol &&
            stylesheetUrl.host === hostUrl.host;
      return sameOrigin ? stylesheetUrl.href : null;
    } catch {
      return null;
    }
  }

  private observePageHide(pipWindow: Window): void {
    if (this.observedWindows.has(pipWindow)) {
      return;
    }
    this.observedWindows.add(pipWindow);
    pipWindow.addEventListener(
      'pagehide',
      () => {
        this.hiddenWindows.add(pipWindow);
        if (this.liveWindow === pipWindow) {
          this.liveWindow = null;
        }
        try {
          this.options.onClose?.(pipWindow);
        } catch {
          // Consumer callbacks must not interrupt lifecycle cleanup.
        }
      },
      { once: true },
    );
  }

  private closeSafely(pipWindow: Window): void {
    try {
      pipWindow.close();
    } catch {
      // Best effort cleanup must not hide the original setup error.
    }
  }

  private reportError(
    reason: Extract<PipActivationResult, { ok: false }>['reason'],
    error: unknown,
  ): void {
    try {
      this.options.onError?.(reason, error);
    } catch {
      // Reporting must not replace the controller's recoverable result.
    }
  }
}
