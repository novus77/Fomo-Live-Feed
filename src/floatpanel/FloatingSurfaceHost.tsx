import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

import { useLocale } from '../i18n/LocaleProvider';
import type { PopupRuntimeLike } from '../popup/popup-io';
import { SidePanelApp, type SidePanelDependencies } from '../sidepanel/SidePanelApp';
import { createSurfaceSwitchClient } from '../sidepanel/surface-switch-client';
import { useSurfaceReady } from '../sidepanel/use-surface-ready';
import {
  DocumentPipController,
  supportsDocumentPip,
  type DocumentPictureInPictureLike,
} from './document-pip';
import { mountPipFeedRoot, type PipFeedRootOptions } from './PipFeedRoot';
import {
  DEFAULT_PIP_GEOMETRY,
  observePipGeometry,
  readPipGeometry,
  type PipGeometry,
} from './pip-geometry';
import { useSurfaceTheme } from './use-surface-theme';

export type FloatingHostState =
  | 'activation'
  | 'opening'
  | 'awaiting-pip-ready'
  | 'active'
  | 'recovery'
  | 'unsupported'
  | 'error';

export type MountPipFeed = (options: PipFeedRootOptions) => () => void;

export interface FloatingSurfaceHostProps {
  deps: SidePanelDependencies;
  documentPip?: DocumentPictureInPictureLike | null;
  hostDocument?: Document;
  mountPipFeed?: MountPipFeed;
  createSessionId?: () => string;
}

interface ActiveSession {
  id: string;
  hostWindowId?: number;
  ownerWindowId?: number;
  pipWindow?: Window;
  cleanup?: () => void;
  readyInFlight: boolean;
  closedReported: boolean;
  cleanupDone: boolean;
  opened: boolean;
  terminal: boolean;
  failureReason?: 'mount-failed';
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

interface OpenedResponse {
  ok: true;
  created: boolean;
  ownerWindowId: number;
}

const isOpenedResponse = (value: unknown): value is OpenedResponse =>
  isRecord(value)
  && Object.keys(value).length === 3
  && Object.keys(value).every((key) => (
    key === 'ok' || key === 'created' || key === 'ownerWindowId'
  ))
  && value.ok === true
  && typeof value.created === 'boolean'
  && typeof value.ownerWindowId === 'number'
  && Number.isInteger(value.ownerWindowId)
  && value.ownerWindowId >= 0;

const isReadyResponse = (value: unknown): boolean =>
  isRecord(value)
  && Object.keys(value).every((key) => key === 'ok' || key === 'minimized')
  && value.ok === true
  && typeof value.minimized === 'boolean';

const newId = (prefix: string): string => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const defaultDocumentPip = (): DocumentPictureInPictureLike | null => {
  const candidate = (globalThis as typeof globalThis & {
    documentPictureInPicture?: unknown;
  }).documentPictureInPicture;
  return supportsDocumentPip(candidate) ? candidate : null;
};

function sendClosed(
  runtime: PopupRuntimeLike,
  session: ActiveSession,
  reason: 'native-close' | 'mount-failed',
): void {
  if (
    !session.opened
    || session.hostWindowId === undefined
    || session.closedReported
  ) return;
  session.closedReported = true;
  try {
    void runtime.sendMessage({
      protocolVersion: 1,
      type: 'pip.closed',
      payload: {
        sessionId: session.id,
        hostWindowId: session.hostWindowId,
        reason,
      },
    }).catch(() => {});
  } catch {
    // Lifecycle teardown remains terminal even if the runtime is gone.
  }
}

export function FloatingSurfaceHost(props: FloatingSurfaceHostProps) {
  const { deps } = props;
  const { translate } = useLocale();
  const api = props.documentPip === undefined
    ? defaultDocumentPip()
    : props.documentPip;
  const supported = supportsDocumentPip(api);
  const [state, setState] = useState<FloatingHostState>(
    supported ? 'activation' : 'unsupported',
  );
  const [childMayBeLive, setChildMayBeLive] = useState(false);
  const [childOwnsRead, setChildOwnsRead] = useState(false);
  const [activationPending, setActivationPending] = useState(false);
  const [geometryHydrated, setGeometryHydrated] = useState(false);
  const theme = useSurfaceTheme(deps);
  const pipGeometryRef = useRef<PipGeometry>({ ...DEFAULT_PIP_GEOMETRY });
  const sessionRef = useRef<ActiveSession | undefined>(undefined);
  const activationInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const surfaceSwitchClient = useMemo(
    () => createSurfaceSwitchClient(
      deps.runtime,
      deps.now,
      (props.hostDocument ?? document).location.href.length > 0
        ? new URL((props.hostDocument ?? document).location.href)
          .searchParams.get('surfaceInstanceToken') ?? undefined
        : undefined,
    ),
    [deps.now, deps.runtime, props.hostDocument],
  );
  const unsupportedReady = useSurfaceReady({
    enabled: state === 'unsupported',
    runtime: deps.runtime,
    getCurrentWindowId: deps.getCurrentWindowId,
    surface: 'floating',
    eventWatermark: 0,
    trackAcknowledgement: true,
    now: deps.now,
    client: surfaceSwitchClient,
  });

  useEffect(() => {
    let disposed = false;
    pipGeometryRef.current = { ...DEFAULT_PIP_GEOMETRY };
    setGeometryHydrated(false);
    void readPipGeometry(deps.storage.local).then((geometry) => {
      if (!disposed) pipGeometryRef.current = geometry;
    }).catch(() => {}).then(() => {
      if (!disposed) setGeometryHydrated(true);
    });
    return () => { disposed = true; };
  }, [deps.storage.local]);
  const finalizeSession = (
    session: ActiveSession,
    reason: 'native-close' | 'mount-failed',
    nextState?: 'recovery' | 'error',
  ): void => {
    session.terminal = true;
    session.readyInFlight = false;
    if (!session.cleanupDone) {
      session.cleanupDone = true;
      const cleanup = session.cleanup;
      delete session.cleanup;
      try {
        cleanup?.();
      } catch {
        // Cleanup is best effort, but this session must stay terminal.
      }
    }
    sendClosed(deps.runtime, session, reason);
    if (mountedRef.current && sessionRef.current === session) {
      setChildMayBeLive(false);
      setChildOwnsRead(false);
      if (nextState !== undefined) setState(nextState);
    }
  };
  const finalizeSessionRef = useRef(finalizeSession);
  finalizeSessionRef.current = finalizeSession;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const session = sessionRef.current;
      if (session === undefined) return;
      session.terminal = true;
      try {
        session.pipWindow?.close();
      } catch {
        // Finalization below still removes the React feed from a live child.
      }
      finalizeSessionRef.current(session, session.failureReason ?? 'native-close');
    };
  }, []);

  const returnToSidePanel = useCallback((): void => {
    void (deps.feedViewStore?.flush() ?? Promise.resolve())
      .then(() => deps.getCurrentWindowId?.() ?? Promise.resolve(0))
      .then((windowId) => surfaceSwitchClient.switchTo('floating', 'sidepanel', windowId))
      .catch(() => {});
  }, [deps.feedViewStore, deps.getCurrentWindowId, surfaceSwitchClient]);

  const controller = useMemo(() => new DocumentPipController(
    props.hostDocument ?? document,
    api,
    {
      width: 380,
      height: 600,
      getGeometry: () => pipGeometryRef.current,
      title: translate('header.title'),
      lang: props.hostDocument?.documentElement.lang ?? document.documentElement.lang,
      bodyClass: 'floatpanel-body pip-body',
      rootId: 'pip-root',
      mount: async (root, pipWindow) => {
        const session = sessionRef.current;
        if (session === undefined || session.terminal || pipWindow.closed) {
          throw new Error('Missing PiP activation session');
        }

        session.pipWindow = pipWindow;
        if (mountedRef.current) setState('awaiting-pip-ready');
        const hostWindowId = await (deps.getCurrentWindowId?.() ?? Promise.resolve(0));
        session.hostWindowId = hostWindowId;
        if (session.terminal || pipWindow.closed) {
          throw new Error('PiP session closed during host lookup');
        }
        const opened = await deps.runtime.sendMessage({
          protocolVersion: 1,
          type: 'pip.opened',
          payload: { sessionId: session.id, hostWindowId },
        });
        const openedAccepted = isOpenedResponse(opened);
        if (openedAccepted) {
          session.opened = true;
          session.ownerWindowId = opened.ownerWindowId;
        }
        if (
          !openedAccepted
          || sessionRef.current !== session
          || session.terminal
          || pipWindow.closed
        ) {
          if (openedAccepted && session.terminal) {
            finalizeSession(session, session.failureReason ?? 'native-close');
          }
          throw new Error('PiP session registration failed');
        }

        const mount = props.mountPipFeed ?? mountPipFeedRoot;
        try {
          const handleReadyFailure = (): void => {
            if (sessionRef.current !== session || session.terminal) return;
            session.failureReason = 'mount-failed';
            session.terminal = true;
            session.readyInFlight = false;
            if (mountedRef.current) {
              setChildMayBeLive(true);
              setState('error');
            }

            try {
              pipWindow.close();
            } catch {
              return;
            }

            // Some Window implementations mark `closed` immediately without
            // dispatching pagehide. Finish the same cleanup here; onClose is
            // idempotent when pagehide was dispatched synchronously.
            if (pipWindow.closed) {
              finalizeSession(session, 'mount-failed', 'error');
            }
          };

          if (mountedRef.current) {
            flushSync(() => setChildOwnsRead(true));
          }
          const stopGeometryObserver = observePipGeometry(
            pipWindow,
            deps.storage.local,
            (geometry) => { pipGeometryRef.current = geometry; },
          );
          let cleanupFeed: (() => void) | undefined;
          session.cleanup = () => {
            stopGeometryObserver();
            cleanupFeed?.();
            cleanupFeed = undefined;
          };
          try {
            cleanupFeed = mount({
              root,
              deps,
              surfaceSwitchClient,
              onFeedReady: (eventWatermark) => {
                if (
                  sessionRef.current !== session
                  || session.terminal
                  || session.readyInFlight
                  || pipWindow.closed
                ) return;
                session.readyInFlight = true;
                void deps.runtime.sendMessage({
                  protocolVersion: 1,
                  type: 'pip.ready',
                  payload: { sessionId: session.id, hostWindowId, eventWatermark },
                }).then((response) => {
                  if (
                    mountedRef.current
                    && sessionRef.current === session
                    && !session.terminal
                    && !pipWindow.closed
                    && isReadyResponse(response)
                  ) {
                    setState('active');
                    return;
                  }
                  session.readyInFlight = false;
                  handleReadyFailure();
                }).catch(() => {
                  handleReadyFailure();
                });
              },
              onReturnToSidePanel: async () => {
                if (
                  sessionRef.current !== session
                  || session.terminal
                  || pipWindow.closed
                  || session.ownerWindowId === undefined
                ) {
                  return false;
                }
                try {
                  const result = await surfaceSwitchClient.returnToSidePanel(
                    session.id,
                    hostWindowId,
                    session.ownerWindowId,
                  );
                  return result.ok;
                } catch {
                  return false;
                }
              },
            });
          } catch (error) {
            if (!session.cleanupDone) {
              session.cleanup?.();
              delete session.cleanup;
            }
            throw error;
          }
          if (session.cleanupDone) {
            cleanupFeed();
            cleanupFeed = undefined;
          }
        } catch (error) {
          session.failureReason = 'mount-failed';
          finalizeSession(session, 'mount-failed', 'error');
          throw error;
        }
      },
      onClose: (pipWindow) => {
        const session = sessionRef.current;
        if (session === undefined || session.pipWindow !== pipWindow) return;
        finalizeSession(
          session,
          session.failureReason ?? 'native-close',
          session.failureReason === 'mount-failed' ? 'error' : 'recovery',
        );
      },
      onError: (reason) => {
        if (reason !== 'mount-failed') return;
        const session = sessionRef.current;
        if (session === undefined || session.terminal) return;
        session.failureReason = 'mount-failed';
        finalizeSession(session, 'mount-failed', 'error');
      },
    },
  ), [api, deps, props.hostDocument, props.mountPipFeed, surfaceSwitchClient, translate]);

  const activate = useCallback((): void => {
    if (!geometryHydrated || activationInFlightRef.current) return;
    activationInFlightRef.current = true;
    const session: ActiveSession = {
      id: props.createSessionId?.() ?? newId('pip'),
      readyInFlight: false,
      closedReported: false,
      cleanupDone: false,
      opened: false,
      terminal: false,
    };
    sessionRef.current = session;
    setChildMayBeLive(false);
    setChildOwnsRead(false);

    // Keep requestWindow inside the trusted click task. No worker or storage
    // await may run before this call.
    const activation = controller.activate();
    setActivationPending(true);
    setState('opening');
    void activation.then((result) => {
      activationInFlightRef.current = false;
      if (!mountedRef.current) return;
      setActivationPending(false);
      if (sessionRef.current !== session) return;
      if (session.terminal) return;
      if (!result.ok) {
        session.cleanup?.();
        setState(result.reason === 'unsupported' ? 'unsupported' : 'error');
      }
    });
  }, [controller, geometryHydrated, props.createSessionId]);

  const busy = activationPending
    || state === 'opening'
    || state === 'awaiting-pip-ready';
  const showFeed = state !== 'unsupported'
    && state !== 'active'
    && !(state === 'error' && childMayBeLive);

  return (
    <div className="floating-surface-host" data-state={state} data-theme={theme}>
      {showFeed && (
        <SidePanelApp
          deps={{ ...deps, readEnabled: !childOwnsRead }}
          surfaceSwitchClient={surfaceSwitchClient}
        />
      )}

      {state === 'unsupported' ? (
        <section className="floating-host-card floating-host-card--standalone">
          <h1>{translate('floating.unsupportedTitle')}</h1>
          <p>{translate('floating.unsupportedBody')}</p>
          <button
            type="button"
            disabled={!unsupportedReady}
            onClick={returnToSidePanel}
          >
            {translate('floating.returnToSidePanel')}
          </button>
        </section>
      ) : state === 'active' ? (
        <div className="floating-lifecycle-shell" role="status" aria-live="polite">
          {translate('floating.active')}
        </div>
      ) : state === 'error' && childMayBeLive ? (
        <div className="floating-lifecycle-shell" role="status" aria-live="polite">
          {translate('floating.error')}
        </div>
      ) : (
        <section className="floating-host-card" aria-live="polite">
          {state === 'recovery' && <p>{translate('floating.recovery')}</p>}
          {state === 'error' && <p>{translate('floating.error')}</p>}
          {busy && <p role="status">{translate('floating.opening')}</p>}
          <div className="floating-host-actions">
            <button
              type="button"
              className="floating-primary-action"
              disabled={busy || !geometryHydrated}
              aria-busy={busy ? 'true' : undefined}
              onClick={activate}
            >
              {state === 'recovery'
                ? translate('floating.reopen')
                : state === 'error'
                  ? translate('floating.retry')
                  : translate('floating.activate')}
            </button>
            {(state === 'recovery' || state === 'error') && (
              <button type="button" onClick={returnToSidePanel}>
                {translate('floating.returnToSidePanel')}
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
