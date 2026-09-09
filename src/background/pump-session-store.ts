import { z } from 'zod';
import { PUMP_CONNECTION_STATUSES } from '../messaging/protocol';

const pumpKeySchema = z.string().trim().min(1).max(512);
const pumpSessionStateSchema = z.object({
  watermark: pumpKeySchema.optional(),
  recentKeys: z.array(pumpKeySchema).max(2_048),
}).strict();

export type PumpSessionState = z.infer<typeof pumpSessionStateSchema>;

const pumpStatusSnapshotSchema = z.object({
  epoch: z.number().int().nonnegative(),
  status: z.enum(PUMP_CONNECTION_STATUSES),
  at: z.number().int().nonnegative(),
  backoffLevel: z.number().int().min(0).max(8),
}).strict();

export type PumpStatusSnapshot = z.infer<typeof pumpStatusSnapshotSchema>;

/**
 * Restored session state crosses the storage boundary and is therefore
 * untrusted. Invalid state is discarded so a damaged value cannot prevent a
 * newly elected Pump tab from receiving a valid lease command.
 */
export function parsePumpSessionState(value: unknown): PumpSessionState | undefined {
  const parsed = pumpSessionStateSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

export function parsePumpStatusSnapshot(value: unknown): PumpStatusSnapshot | undefined {
  const parsed = pumpStatusSnapshotSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
