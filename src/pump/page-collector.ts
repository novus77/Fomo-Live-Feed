import { nextPumpDelay, reduceBackoffAfterSuccess } from './backoff';
import { fetchPumpFollowingTrades, PumpFetchError } from './http-client';
import { PumpPollingSession } from './polling-session';
import {
  parsePumpLeaseCommand,
  pumpRuntimeCandidate,
  type PumpOutboundRuntimeMessage,
} from './window-protocol';

interface CollectorWindow {
  readonly location: { origin: string };
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export function installPumpPageCollector(win: CollectorWindow): { uninstall(): void } {
  let epoch = -1;
  let session: PumpPollingSession | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let cursor: string | undefined;
  let active = false;
  let terminalEpoch = -1;
  let backoffLevel = 0;
  let successfulRecoveryCount = 0;

  const post = (message: PumpOutboundRuntimeMessage): void => {
    win.postMessage(pumpRuntimeCandidate(message), win.location.origin);
  };

  const status = (value: Extract<PumpOutboundRuntimeMessage, { type: 'pump.status' }>['payload']['status']): void => {
    post({
      protocolVersion: 1,
      type: 'pump.status',
      payload: { epoch, status: value, at: Date.now(), backoffLevel },
    });
  };

  const stop = (): void => {
    active = false;
    clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
  };

  const publish = (
    items: Array<{} | null>,
    delivery: 'live' | 'recovered',
    possibleGap: boolean,
  ): void => {
    const snapshot = session?.snapshot() ?? { recentKeys: [] };
    const chunks = items.length === 0
      ? [[]]
      : Array.from({ length: Math.ceil(items.length / 100) }, (_, index) =>
          items.slice(index * 100, index * 100 + 100));
    for (const chunk of chunks) {
      post({
        protocolVersion: 1,
        type: 'pump.batch',
        payload: {
          epoch,
          delivery,
          items: chunk,
          ...(snapshot.watermark !== undefined ? { watermark: snapshot.watermark } : {}),
          recentKeys: snapshot.recentKeys,
          possibleGap,
          at: Date.now(),
        },
      });
    }
  };

  const schedule = (delayMs: number): void => {
    clearTimeout(timer);
    timer = setTimeout(() => void poll(), delayMs);
  };

  const poll = async (): Promise<void> => {
    if (!active || controller !== undefined || session === undefined) return;
    const pollingEpoch = epoch;
    const startedAt = performance.now();
    const requestController = new AbortController();
    controller = requestController;
    try {
      const page = await fetchPumpFollowingTrades({
        ...(cursor !== undefined ? { cursor } : {}),
        signal: requestController.signal,
      });
      if (!active || epoch !== pollingEpoch) return;
      const result = cursor === undefined
        ? session.acceptNewestPage(page)
        : session.acceptCatchUpPage(page);
      const recovered = reduceBackoffAfterSuccess(backoffLevel, successfulRecoveryCount);
      backoffLevel = recovered.level;
      successfulRecoveryCount = recovered.successes;

      if (result.status === 'catching-up') {
        cursor = result.cursor;
        status('catching-up');
        schedule(0);
        return;
      }

      cursor = undefined;
      if (result.status === 'initial') publish([], 'live', false);
      if (result.status === 'events') publish(result.items, result.delivery, false);
      if (result.status === 'possible-gap') publish(result.items, 'recovered', true);
      status(result.status === 'possible-gap' ? 'possible-gap' : 'live');
      schedule(Math.max(0, 1_000 - (performance.now() - startedAt)));
    } catch (error) {
      if (!active || epoch !== pollingEpoch) return;
      successfulRecoveryCount = 0;
      const failure = error instanceof PumpFetchError ? error : new PumpFetchError('network');
      if (failure.kind === 'authentication' || failure.kind === 'protocol') {
        terminalEpoch = epoch;
        status(failure.kind === 'authentication'
          ? 'authentication-required'
          : 'protocol-incompatible');
        stop();
        return;
      }
      const next = nextPumpDelay({
        failure: failure.kind === 'rate-limit' ? 'rate-limit'
          : failure.kind === 'server' ? 'server' : 'network',
        level: backoffLevel,
        ...(failure.retryAfterMs !== undefined ? { retryAfterMs: failure.retryAfterMs } : {}),
        random: Math.random(),
      });
      backoffLevel = next.level;
      status(failure.kind === 'rate-limit' ? 'rate-limited' : 'delayed');
      schedule(next.delayMs);
    } finally {
      if (controller === requestController) controller = undefined;
    }
  };

  const onMessage = (event: MessageEvent): void => {
    if (event.source !== win || win.location.origin !== 'https://pump.fun' && win.location.origin !== 'https://www.pump.fun') return;
    const command = parsePumpLeaseCommand(event.data);
    if (command === null) return;
    if (!command.payload.granted) {
      stop();
      status('disconnected');
      return;
    }
    if (command.payload.epoch < epoch || command.payload.epoch === terminalEpoch) return;
    if (command.payload.epoch > epoch || session === undefined) {
      stop();
      epoch = command.payload.epoch;
      const seed = command.payload.seed === undefined ? undefined : {
        recentKeys: command.payload.seed.recentKeys,
        ...(command.payload.seed.watermark !== undefined
          ? { watermark: command.payload.seed.watermark }
          : {}),
      };
      session = new PumpPollingSession({
        startedAt: Date.now(),
        ...(seed !== undefined ? { seed } : {}),
      });
      cursor = undefined;
      backoffLevel = 0;
      successfulRecoveryCount = 0;
    }
    if (!active) {
      active = true;
      schedule(0);
    }
  };

  win.addEventListener('message', onMessage);
  return {
    uninstall(): void {
      stop();
      win.removeEventListener('message', onMessage);
    },
  };
}
