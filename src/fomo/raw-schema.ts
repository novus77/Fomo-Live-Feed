import { z } from 'zod';

const finiteNonNegativeNumber = z.number().finite().nonnegative();
export const MAX_RAW_IMAGE_LENGTH = 2048;

/**
 * Upper bounds for intercepted string fields.
 *
 * The Fomo WebSocket is an internal, version-unstable API (design spec section
 * 3), so a frame may carry arbitrarily long values. Bounding them here keeps a
 * hostile or malformed frame from persisting unbounded text into IndexedDB and
 * from reaching downstream validators with pathological input. The limits are
 * generous relative to real values: identifiers and tickers are short, the
 * longest supported contract address is a 44-character Base58 Solana address,
 * and thesis comments are prose.
 */
const MAX_IDENTIFIER_LENGTH = 128;
const MAX_ADDRESS_LENGTH = 128;
const MAX_COMMENT_LENGTH = 4096;

const nonEmptyString = z.string().trim().min(1).max(MAX_IDENTIFIER_LENGTH);
const addressString = z.string().trim().min(1).max(MAX_ADDRESS_LENGTH);
const commentString = z.string().max(MAX_COMMENT_LENGTH);

const optionalImageInput = z.unknown().transform((value): string | undefined =>
  typeof value === 'string' && value.length <= MAX_RAW_IMAGE_LENGTH
    ? value
    : undefined,
);

export const rawActivitySchema = z
  .object({
    id: nonEmptyString.optional(),
    tradeId: nonEmptyString.optional(),
    type: z.enum([
      'swap_buy',
      'swap_sell',
      'swap_withdraw',
      'transfer_out',
      'thesis',
    ]),
    userId: nonEmptyString,
    userHandle: nonEmptyString,
    ticker: nonEmptyString,
    tokenAddress: addressString,
    networkId: z.number().int(),
    createdAt: z.string().datetime({ offset: true }),
    displayName: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
    profilePictureLink: optionalImageInput.optional(),
    tokenImageUrl: optionalImageInput.optional(),
    usdAmount: finiteNonNegativeNumber.optional(),
    marketCap: finiteNonNegativeNumber.optional(),
    price: finiteNonNegativeNumber.optional(),
    comment: z
      .union([commentString, z.object({ comment: commentString })])
      .optional(),
  })
  .passthrough();

export type RawActivity = z.infer<typeof rawActivitySchema>;
