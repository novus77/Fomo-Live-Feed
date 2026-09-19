import { z } from 'zod';

export const PUMP_GAP_STORAGE_KEY = 'pump.gap.v1';

export const PUMP_GAP_REASONS = [
  'age-limit',
  'event-limit',
  'endpoint-ended',
  'cursor-loop',
  'unspecified',
] as const;

export type PumpGapReason = (typeof PUMP_GAP_REASONS)[number];

export interface PumpGapStateV1 {
  schemaVersion: 1;
  hasUnresolvedGap: true;
  lastGapAt: number;
  reason: PumpGapReason;
  acknowledgedAt?: number;
}

const pumpGapStateSchema = z.object({
  schemaVersion: z.literal(1),
  hasUnresolvedGap: z.literal(true),
  lastGapAt: z.number().int().nonnegative().finite(),
  reason: z.enum(PUMP_GAP_REASONS),
  acknowledgedAt: z.number().int().nonnegative().finite().optional(),
}).strict();

/** Parses only an explicit unresolved-gap record. A missing key means none. */
export function parsePumpGapState(value: unknown): PumpGapStateV1 | undefined {
  const parsed = pumpGapStateSchema.safeParse(value);

  if (!parsed.success) {
    return undefined;
  }

  return {
    schemaVersion: parsed.data.schemaVersion,
    hasUnresolvedGap: parsed.data.hasUnresolvedGap,
    lastGapAt: parsed.data.lastGapAt,
    reason: parsed.data.reason,
    ...(parsed.data.acknowledgedAt === undefined
      ? {}
      : { acknowledgedAt: parsed.data.acknowledgedAt }),
  };
}

export function createPumpGapState(
  at: number,
  reason: PumpGapReason = 'unspecified',
): PumpGapStateV1 {
  if (!Number.isSafeInteger(at) || at < 0) {
    throw new TypeError('gap timestamp must be a non-negative safe integer');
  }

  return {
    schemaVersion: 1,
    hasUnresolvedGap: true,
    lastGapAt: at,
    reason,
  };
}
