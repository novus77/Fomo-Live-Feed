import { nextPumpDelay, reduceBackoffAfterSuccess } from './backoff';
import { fetchPumpFollowingTrades, PumpFetchError } from './http-client';
import { PumpPollingSession } from './polling-session';
import type { RawPumpTrade } from './raw-schema';
import { PumpRecentKeys, pumpTransactionKey } from './watermark';
import type { PumpGapReason } from '../background/pump-gap-store';
import {
  parsePumpBatchAck,
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

type PumpBatchMessage = Extract<PumpOutboundRuntimeMessage, { type: 'pump.batch' }>;

export function installPumpPageCollector(win: CollectorWindow): { uninstall(): void } {
  let epoch = -1;
  let workerSessionId: string | undefined;
  let leaseExpiresAt = 0;
  let session: PumpPollingSession | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let cursor: string | undefined;
  let active = false;
  let terminalEpoch = -1;
  let backoffLevel = 0;
  let successfulRecoveryCount = 0;
  let committedSeed: { watermark?: string; recentKeys: string[] } | undefined;
  let pending: { epoch: number; batches: PumpBatchMessage[]; delayMs: number } | undefined;
  let acknowledgementTimer: ReturnType<typeof setTimeout> | undefined;
  let nextBatchNumber = 0;

  const post = (message: PumpOutboundRuntimeMessage): void => {
    win.postMessage(pumpRuntimeCandidate(message), win.location.origin);
  };

  const status = (value: Extract<PumpOutboundRuntimeMessage, { type: 'pump.status' }>['payload']['status'], gapReason?: PumpGapReason): void => {
    post({
      protocolVersion: 1,
      type: 'pump.status',
      payload: {
        epoch,
        ...(workerSessionId !== undefined ? { workerSessionId } : {}),
        status: value,
        at: Date.now(),
        backoffLevel,
        ...(gapReason === undefined ? {} : { gapReason }),
      },
    });
  };

  const stop = (): void => {
    active = false;
    clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
    clearTimeout(acknowledgementTimer);
    acknowledgementTimer = undefined;
  };

  const retryPending = (): void => {
    if (pending === undefined) return;
    const retrySeed = committedSeed;
    pending = undefined;
    clearTimeout(acknowledgementTimer);
    acknowledgementTimer = undefined;
    session = new PumpPollingSession({
      startedAt: Date.now(),
      ...(retrySeed !== undefined ? { seed: retrySeed } : {}),
    });
    cursor = undefined;
    schedule(250);
  };

  const expireLease = (): void => {
    pending = undefined;
    clearTimeout(acknowledgementTimer);
    acknowledgementTimer = undefined;
    session = new PumpPollingSession({
      startedAt: Date.now(),
      ...(committedSeed !== undefined ? { seed: committedSeed } : {}),
    });
    cursor = undefined;
    stop();
    status('disconnected');
  };

  const postPendingBatch = (): void => {
    const batch = pending?.batches[0];
    if (batch === undefined) return;
    clearTimeout(acknowledgementTimer);
    acknowledgementTimer = setTimeout(retryPending, 5_000);
    post(batch);
  };

  const publish = (
    items: RawPumpTrade[],
    delivery: 'live' | 'recovered',
    possibleGap: boolean,
    delayMs: number,
  ): void => {
    const snapshot = session?.snapshot() ?? { recentKeys: [] };
    const chunks = items.length === 0
      ? [[]]
      : Array.from({ length: Math.ceil(items.length / 100) }, (_, index) =>
          items.slice(index * 100, index * 100 + 100));
    const checkpointKeys = new PumpRecentKeys(committedSeed?.recentKeys);
    const batches = chunks.map((chunk, index): PumpBatchMessage => {
      for (const item of chunk) checkpointKeys.add(pumpTransactionKey(item.chainId, item.trade.tx));
      // Earlier chunks cannot checkpoint rows that have not reached the worker.
      const checkpoint = index === chunks.length - 1 ? snapshot : {
        ...(committedSeed?.watermark !== undefined ? { watermark: committedSeed.watermark } : {}),
        recentKeys: checkpointKeys.values(),
      };
      const batchId = `${epoch}:${++nextBatchNumber}`;
      return {
        protocolVersion: 1,
        type: 'pump.batch',
        payload: {
          epoch,
          ...(workerSessionId !== undefined ? { workerSessionId } : {}),
          batchId,
          delivery,
          items: chunk,
          ...(checkpoint.watermark !== undefined ? { watermark: checkpoint.watermark } : {}),
          recentKeys: checkpoint.recentKeys,
          possibleGap,
          at: Date.now(),
        },
      };
    });
    pending = { epoch, batches, delayMs };
    postPendingBatch();
  };

  const schedule = (delayMs: number): void => {
    clearTimeout(timer);
    timer = setTimeout(() => void poll(), delayMs);
  };

  const poll = async (): Promise<void> => {
    if (!active || pending !== undefined || controller !== undefined || session === undefined) return;
    if (Date.now() >= leaseExpiresAt) {
      expireLease();
      return;
    }
    const pollingEpoch = epoch;
    const pollingSession = session;
    const pollingWorkerSessionId = workerSessionId;
    const startedAt = performance.now();
    const requestController = new AbortController();
    controller = requestController;
    try {
      const page = await fetchPumpFollowingTrades({
        ...(cursor !== undefined ? { cursor } : {}),
        signal: requestController.signal,
      });
      if (!active || epoch !== pollingEpoch || session !== pollingSession || workerSessionId !== pollingWorkerSessionId) return;
      if (Date.now() >= leaseExpiresAt) {
        expireLease();
        return;
      }
      const result = cursor === undefined
        ? pollingSession.acceptNewestPage(page)
        : pollingSession.acceptCatchUpPage(page);
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
      const nextDelay = Math.max(0, 1_000 - (performance.now() - startedAt));
      if (result.status === 'initial') publish([], 'live', false, nextDelay);
      if (result.status === 'events') publish(result.items, result.delivery, false, nextDelay);
      if (result.status === 'possible-gap') publish(result.items, 'recovered', true, nextDelay);
      if (result.status === 'possible-gap') status('possible-gap', result.reason);
      else status('live');
      if (pending === undefined) schedule(nextDelay);
    } catch (error) {
      if (!active || epoch !== pollingEpoch || session !== pollingSession || workerSessionId !== pollingWorkerSessionId) return;
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
    const ack = parsePumpBatchAck(event.data);
    if (ack !== null) {
      const batch = pending?.batches[0];
      if (pending === undefined || batch === undefined || ack.payload.epoch !== pending.epoch || batch.payload.batchId !== ack.payload.batchId) return;
      if (!ack.payload.ok) {
        retryPending();
        return;
      }
      committedSeed = {
        ...(batch.payload.watermark !== undefined ? { watermark: batch.payload.watermark } : {}),
        recentKeys: batch.payload.recentKeys,
      };
      pending.batches.shift();
      if (pending.batches.length === 0) {
        const delayMs = pending.delayMs;
        pending = undefined;
        clearTimeout(acknowledgementTimer);
        acknowledgementTimer = undefined;
        schedule(delayMs);
      } else {
        postPendingBatch();
      }
      return;
    }
    if (command === null) return;
    if (!command.payload.granted) {
      stop();
      status('disconnected');
      return;
    }
    const isNewWorker = command.payload.workerSessionId !== workerSessionId;
    if (!isNewWorker && (command.payload.epoch < epoch || command.payload.epoch === terminalEpoch)) return;
    if (!isNewWorker && active && Date.now() >= leaseExpiresAt) {
      expireLease();
    }
    if (isNewWorker || command.payload.epoch > epoch || session === undefined) {
      stop();
      workerSessionId = command.payload.workerSessionId;
      epoch = command.payload.epoch;
      terminalEpoch = -1;
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
      committedSeed = seed === undefined ? undefined : {
        recentKeys: [...seed.recentKeys],
        ...(seed.watermark !== undefined ? { watermark: seed.watermark } : {}),
      };
      cursor = undefined;
      pending = undefined;
      backoffLevel = 0;
      successfulRecoveryCount = 0;
    }
    leaseExpiresAt = command.payload.expiresAt;
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
