import type { TradeEventV1 } from '../domain/activity';
import { toTradeEvent } from '../domain/event-validation';
import type {
  ConnectionQueryResponse,
  EventQuery,
  ExtensionMessage,
  PipelineHealthQueryResponse,
} from '../messaging/protocol';
import type { LocalPreferencesStorage } from '../storage/local-preferences';

/**
 * Popup I/O boundary (plan Task 9/10).
 *
 * The popup talks to the service worker ONLY through the shared protocol
 * envelope (src/messaging/protocol.ts) - no local message shapes. This module
 * owns the exact builders the popup sends, so the worker boundary test can
 * feed these same objects into the worker's real listener. The storage
 * surface is the same chrome.storage.local subset LocalPreferences already
 * uses, plus the onChanged listener the popup injects for immediate
 * annotation/settings propagation (plan Task 10 Step 1).
 */

/** The subset of chrome.runtime the popup relies on. */
export interface PopupRuntimeLike {
  sendMessage(message: unknown): Promise<unknown>;
  onMessage: {
    addListener(listener: (message: unknown) => void): void;
    removeListener(listener: (message: unknown) => void): void;
  };
}

/** The subset of chrome.storage the popup relies on. */
export interface PopupStorageLike {
  local: LocalPreferencesStorage;
  onChanged: {
    addListener(
      listener: (changes: Record<string, unknown>, areaName: string) => void,
    ): void;
    removeListener(
      listener: (changes: Record<string, unknown>, areaName: string) => void,
    ): void;
  };
}

/** The worker's reply shape for events.query, mirrored from the boundary. */
interface EventsQueryResponseLike {
  ok: true;
  events: TradeEventV1[];
}

export function buildEventQueryMessage(query: EventQuery): ExtensionMessage {
  return { protocolVersion: 1, type: 'events.query', payload: query };
}

export function buildMarkReadMessage(
  ids: readonly string[],
  at: number,
): ExtensionMessage {
  return { protocolVersion: 1, type: 'events.markRead', payload: { ids: [...ids], at } };
}

export function buildConnectionQueryMessage(): ExtensionMessage {
  return { protocolVersion: 1, type: 'connection.query' };
}

export function buildPipelineHealthQueryMessage(): ExtensionMessage {
  return { protocolVersion: 1, type: 'pipeline.healthQuery' };
}

export function buildPreferencesChangedMessage(): ExtensionMessage {
  return { protocolVersion: 1, type: 'preferences.changed' };
}

/**
 * Bounded per-runtime cap on popup-recorded schema-rejection diagnostics
 * (BLOCKING 3). The worker's DiagnosticRecorder ring buffer already caps
 * total records; this cap prevents a pathological page loop from flooding
 * the worker with one message per query call.
 */
const MAX_POPUP_SCHEMA_DIAGNOSTICS = 20;

const diagnosticCounts = new WeakMap<object, number>();

function recordInvalidRowsDiagnostic(runtime: PopupRuntimeLike): void {
  const key = runtime as object;
  const sent = diagnosticCounts.get(key) ?? 0;

  if (sent >= MAX_POPUP_SCHEMA_DIAGNOSTICS) {
    return;
  }

  diagnosticCounts.set(key, sent + 1);

  void runtime
    .sendMessage({
      protocolVersion: 1,
      type: 'diagnostics.record',
      payload: { code: 'schema_rejection', messageType: 'events.query' },
    })
    .catch(() => {});
}

/**
 * Sends events.query and returns the validated event rows; throws on a bad
 * reply envelope.
 *
 * BLOCKING 3: every returned row is re-validated with the SHARED runtime
 * validator (src/domain/event-validation.ts, the same one the overlay uses
 * for broadcasts). One malformed row (DB corruption, or a future schema v2)
 * must never blank the whole popup: invalid rows are dropped and a bounded,
 * redacted schema_rejection diagnostic is recorded via the worker.
 */
export async function queryEvents(
  runtime: PopupRuntimeLike,
  query: EventQuery,
): Promise<TradeEventV1[]> {
  const response = (await runtime.sendMessage(
    buildEventQueryMessage(query),
  )) as EventsQueryResponseLike | undefined;

  if (response === undefined || response.ok !== true || !Array.isArray(response.events)) {
    throw new Error('popup: events.query returned an unexpected response');
  }

  const rows: unknown[] = response.events;
  const validated: TradeEventV1[] = [];
  let dropped = 0;

  for (const row of rows) {
    const event = toTradeEvent(row);

    if (event === null) {
      dropped += 1;
    } else {
      validated.push(event);
    }
  }

  if (dropped > 0) {
    recordInvalidRowsDiagnostic(runtime);
  }

  return validated;
}

/**
 * Sends events.markRead; resolves TRUE only when the worker confirmed the
 * write (ok:true), FALSE on a rejected send or bad reply. A rejected read
 * must never crash the feed, and the caller must never update its local
 * readAt without confirmation (NIT: the UI would lie until reopen).
 */
export async function markEventsRead(
  runtime: PopupRuntimeLike,
  ids: readonly string[],
  at: number,
): Promise<boolean> {
  try {
    const response = (await runtime.sendMessage(
      buildMarkReadMessage(ids, at),
    )) as { ok?: unknown } | undefined;

    return response?.ok === true;
  } catch {
    return false;
  }
}

/** Sends connection.query and returns the worker's verdict. */
export async function queryConnection(
  runtime: PopupRuntimeLike,
): Promise<ConnectionQueryResponse> {
  const response = (await runtime.sendMessage(
    buildConnectionQueryMessage(),
  )) as ConnectionQueryResponse | undefined;

  if (response === undefined || response.ok !== true) {
    throw new Error('popup: connection.query returned an unexpected response');
  }

  return response;
}

/** Sends pipeline.healthQuery and returns the validated response envelope. */
export async function queryPipelineHealth(
  runtime: PopupRuntimeLike,
): Promise<PipelineHealthQueryResponse> {
  const response = (await runtime.sendMessage(
    buildPipelineHealthQueryMessage(),
  )) as PipelineHealthQueryResponse | undefined;

  if (response === undefined || response.ok !== true || response.health === undefined) {
    throw new Error('sidepanel: pipeline.healthQuery returned an unexpected response');
  }

  return response;
}

/** Notifies the worker that preferences changed (toast suppression refresh). */
export function notifyPreferencesChanged(runtime: PopupRuntimeLike): void {
  void runtime.sendMessage(buildPreferencesChangedMessage()).catch(() => {});
}
