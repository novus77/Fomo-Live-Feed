import { z } from 'zod';

export const MAX_PUMP_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_PUMP_PAGE_ITEMS = 100;
export const MAX_PUMP_CURSOR_LENGTH = 4_096;
export const MAX_PUMP_FUTURE_SKEW_MS = 5 * 60 * 1_000;

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_ADDRESS_LENGTH = 128;
const MAX_TRANSACTION_LENGTH = 128;
const MAX_SYMBOL_LENGTH = 64;
const MAX_IMAGE_URL_LENGTH = 2_048;
const MAX_FINANCIAL_VALUE = 1e15;

const boundedRequiredString = (maximum: number) =>
  z.string().trim().min(1).max(maximum);

const isoTimestamp = boundedRequiredString(64).refine(
  (value) => Number.isFinite(Date.parse(value)),
  { message: 'invalid timestamp' },
);

const boundedFinancial = z.number().finite().nonnegative().max(MAX_FINANCIAL_VALUE);

const optionalBoundedImage = z.unknown().transform((value): string | undefined =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_IMAGE_URL_LENGTH
    ? value
    : undefined,
);

const rawPumpAuthorSchema = z.object({
  userId: boundedRequiredString(MAX_IDENTIFIER_LENGTH),
  userName: boundedRequiredString(MAX_IDENTIFIER_LENGTH),
  profileImage: optionalBoundedImage.optional(),
  xUsername: boundedRequiredString(MAX_IDENTIFIER_LENGTH)
    .nullish()
    .transform((value): string | undefined => value ?? undefined),
});

const rawPumpTradeDetailSchema = z.object({
  tx: boundedRequiredString(MAX_TRANSACTION_LENGTH),
  isBuy: z.boolean(),
  timestamp: isoTimestamp,
  amountUsd: boundedFinancial,
  baseAmount: boundedFinancial.optional(),
  priceUsd: boundedFinancial.optional(),
});

export const rawPumpTradeSchema = z.object({
  kind: z.literal('trade'),
  author: rawPumpAuthorSchema,
  coinMint: boundedRequiredString(MAX_ADDRESS_LENGTH),
  chainId: z.number().int().nonnegative().finite(),
  createdAt: isoTimestamp,
  coinName: boundedRequiredString(MAX_IDENTIFIER_LENGTH).optional(),
  coinImage: optionalBoundedImage.optional(),
  symbol: boundedRequiredString(MAX_SYMBOL_LENGTH),
  marketCap: boundedFinancial.optional(),
  trade: rawPumpTradeDetailSchema,
});

export type RawPumpTrade = z.infer<typeof rawPumpTradeSchema>;

export interface PumpPageParseResult {
  accepted: RawPumpTrade[];
  rejectedCount: number;
  nextCursor?: string;
}

export class PumpProtocolError extends Error {
  constructor() {
    super('Invalid Pump trade response');
    this.name = 'PumpProtocolError';
  }
}

const rawPumpPageEnvelopeSchema = z.object({
  items: z.array(z.unknown()).max(MAX_PUMP_PAGE_ITEMS),
  nextCursor: z
    .union([z.string().min(1).max(MAX_PUMP_CURSOR_LENGTH), z.null()])
    .optional(),
});

/**
 * Parses one Pump Following trade page while discarding every unneeded field.
 * Errors intentionally carry no response detail so raw payload data cannot
 * leak into diagnostics or logs.
 */
export function parsePumpTradePage(
  payload: unknown,
  responseBytes?: number,
  now?: number,
): PumpPageParseResult {
  if (
    responseBytes !== undefined &&
    (!Number.isInteger(responseBytes) ||
      responseBytes < 0 ||
      responseBytes > MAX_PUMP_RESPONSE_BYTES)
  ) {
    throw new PumpProtocolError();
  }

  const envelope = rawPumpPageEnvelopeSchema.safeParse(payload);

  if (!envelope.success) {
    throw new PumpProtocolError();
  }

  const accepted: RawPumpTrade[] = [];
  let rejectedCount = 0;
  const referenceTime = now ?? Date.now();

  if (!Number.isInteger(referenceTime) || referenceTime < 0) {
    throw new PumpProtocolError();
  }

  for (const candidate of envelope.data.items) {
    const parsed = rawPumpTradeSchema.safeParse(candidate);

    if (
      parsed.success &&
      Date.parse(parsed.data.trade.timestamp) <= referenceTime + MAX_PUMP_FUTURE_SKEW_MS &&
      Date.parse(parsed.data.createdAt) <= referenceTime + MAX_PUMP_FUTURE_SKEW_MS
    ) {
      accepted.push(parsed.data);
    } else {
      rejectedCount += 1;
    }
  }

  if (
    envelope.data.items.length > 0 &&
    rejectedCount >= 3 &&
    rejectedCount / envelope.data.items.length >= 0.2
  ) {
    throw new PumpProtocolError();
  }

  return {
    accepted,
    rejectedCount,
    ...(typeof envelope.data.nextCursor === 'string'
      ? { nextCursor: envelope.data.nextCursor }
      : {}),
  };
}
