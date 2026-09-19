import { z } from 'zod';

import {
  PROTOCOL_VERSION,
  parseExtensionMessage,
  type ExtensionMessage,
} from '../messaging/protocol';

export const PUMP_WINDOW_NAMESPACE = 'fomo-live-feed:pump';

const boundedKey = z.string().trim().min(1).max(512);
const seedSchema = z.object({
  watermark: boundedKey.optional(),
  recentKeys: z.array(boundedKey).max(2_048),
}).strict();

const leaseCommandSchema = z.object({
  namespace: z.literal(PUMP_WINDOW_NAMESPACE),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal('pump.leaseCommand'),
  payload: z.object({
    granted: z.boolean(),
    workerSessionId: boundedKey,
    epoch: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    seed: seedSchema.optional(),
  }).strict(),
}).strict();

const runtimeCandidateEnvelopeSchema = z.object({
  namespace: z.literal(PUMP_WINDOW_NAMESPACE),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal('pump.runtimeCandidate'),
  message: z.unknown(),
}).strict();

export type PumpLeaseCommand = z.infer<typeof leaseCommandSchema>;
export type PumpOutboundRuntimeMessage = Extract<
  ExtensionMessage,
  { type: 'pump.batch' | 'pump.status' | 'pump.pageHidden' }
>;

const batchAckSchema = z.object({
  namespace: z.literal(PUMP_WINDOW_NAMESPACE),
  protocolVersion: z.literal(PROTOCOL_VERSION),
  type: z.literal('pump.batchAck'),
  payload: z.object({
    epoch: z.number().int().nonnegative(),
    batchId: boundedKey,
    ok: z.boolean(),
  }).strict(),
}).strict();

export type PumpBatchAck = z.infer<typeof batchAckSchema>;

export function parsePumpLeaseCommand(value: unknown): PumpLeaseCommand | null {
  const result = leaseCommandSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function parsePumpRuntimeCandidate(value: unknown): {
  message: PumpOutboundRuntimeMessage;
} | null {
  const envelope = runtimeCandidateEnvelopeSchema.safeParse(value);
  if (!envelope.success) return null;
  const parsed = parseExtensionMessage(envelope.data.message);
  if (!parsed.ok) return null;
  if (
    parsed.message.type !== 'pump.batch' &&
    parsed.message.type !== 'pump.status' &&
    parsed.message.type !== 'pump.pageHidden'
  ) return null;
  return { message: parsed.message };
}

export function parsePumpBatchAck(value: unknown): PumpBatchAck | null {
  const result = batchAckSchema.safeParse(value);
  return result.success ? result.data : null;
}

export function pumpRuntimeCandidate(message: PumpOutboundRuntimeMessage): unknown {
  return {
    namespace: PUMP_WINDOW_NAMESPACE,
    protocolVersion: PROTOCOL_VERSION,
    type: 'pump.runtimeCandidate',
    message,
  };
}
