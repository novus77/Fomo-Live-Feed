import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);
const finiteNonNegativeNumber = z.number().finite().nonnegative();

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
    tokenAddress: nonEmptyString,
    networkId: z.number().int(),
    createdAt: z.string().datetime({ offset: true }),
    displayName: z.string().optional(),
    profilePictureLink: z.url().optional(),
    tokenImageUrl: z.url().optional(),
    usdAmount: finiteNonNegativeNumber.optional(),
    marketCap: finiteNonNegativeNumber.optional(),
    price: finiteNonNegativeNumber.optional(),
    comment: z.union([z.string(), z.object({ comment: z.string() })]).optional(),
  })
  .passthrough();

export type RawActivity = z.infer<typeof rawActivitySchema>;
