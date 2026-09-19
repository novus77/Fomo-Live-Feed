import { PROTOCOL_VERSION } from '../messaging/protocol';
import { isAllowedPumpOrigin } from '../messaging/guards';
import {
  PUMP_WINDOW_NAMESPACE,
  parsePumpLeaseCommand,
  parsePumpRuntimeCandidate,
} from './window-protocol';

export function installPumpBridge(options: {
  window: Window;
  sendMessage(message: unknown): Promise<unknown>;
}): { uninstall(): void } {
  const win = options.window;
  if (!isAllowedPumpOrigin(win.location.origin)) return { uninstall() {} };
  let epoch: number | undefined;
  let workerSessionId: string | undefined;

  const requestLease = async (): Promise<void> => {
    try {
      const reply = await options.sendMessage({
        protocolVersion: PROTOCOL_VERSION,
        type: 'pump.lease.request',
        payload: {
          ...(epoch !== undefined ? { epoch } : {}),
          ...(workerSessionId !== undefined ? { workerSessionId } : {}),
          at: Date.now(),
        },
      }) as Record<string, unknown> | undefined;
      if (reply?.ok !== true) return;
      const candidate = {
        namespace: PUMP_WINDOW_NAMESPACE,
        protocolVersion: PROTOCOL_VERSION,
        type: 'pump.leaseCommand',
        payload: {
          granted: reply.granted,
          workerSessionId: reply.workerSessionId,
          epoch: reply.epoch,
          expiresAt: reply.expiresAt,
          ...(reply.seed !== undefined ? { seed: reply.seed } : {}),
        },
      };
      const command = parsePumpLeaseCommand(candidate);
      if (command === null) return;
      epoch = command.payload.granted ? command.payload.epoch : undefined;
      workerSessionId = command.payload.workerSessionId;
      win.postMessage(command, win.location.origin);
    } catch {
      // A suspended worker or navigation is retried by the next lease tick.
    }
  };

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== win) return;
    const candidate = parsePumpRuntimeCandidate(event.data);
    if (candidate === null) return;
    void options.sendMessage(candidate.message).then((reply) => {
      if (candidate.message.type !== 'pump.batch') return;
      const batchId = candidate.message.payload.batchId;
      if (batchId === undefined) return;
      const ok = typeof reply === 'object' && reply !== null &&
        (reply as { ok?: unknown }).ok === true;
      win.postMessage({
        namespace: PUMP_WINDOW_NAMESPACE,
        protocolVersion: PROTOCOL_VERSION,
        type: 'pump.batchAck',
        payload: { epoch: candidate.message.payload.epoch, batchId, ok },
      }, win.location.origin);
    }).catch(() => {});
  };
  const onPageHide = (): void => {
    if (epoch === undefined) return;
    void options.sendMessage({
      protocolVersion: PROTOCOL_VERSION,
      type: 'pump.pageHidden',
      payload: {
        epoch,
        ...(workerSessionId !== undefined ? { workerSessionId } : {}),
        at: Date.now(),
      },
    }).catch(() => {});
  };

  win.addEventListener('message', onMessage);
  win.addEventListener('pagehide', onPageHide);
  const leaseTimer = setInterval(() => void requestLease(), 2_000);
  void requestLease();
  return {
    uninstall(): void {
      clearInterval(leaseTimer);
      win.removeEventListener('message', onMessage);
      win.removeEventListener('pagehide', onPageHide);
    },
  };
}
