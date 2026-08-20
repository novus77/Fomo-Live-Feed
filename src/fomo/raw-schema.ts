import { z } from 'zod';

const nonEmptyString = z.string().trim().min(1);
const finiteNonNegativeNumber = z.number().finite().nonnegative();
const MAX_URL_LENGTH = 2048;

function httpsUrlSchema(fieldName: string) {
  return z
    .string()
    .max(MAX_URL_LENGTH, `${fieldName} must be at most ${MAX_URL_LENGTH} characters`)
    .refine((value) => {
      try {
        const url = new URL(value);

        return url.protocol === 'https:';
      } catch {
        return false;
      }
    }, `${fieldName} must be a valid HTTPS URL`);
}

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
    profilePictureLink: httpsUrlSchema('profilePictureLink').optional(),
    tokenImageUrl: httpsUrlSchema('tokenImageUrl').optional(),
    usdAmount: finiteNonNegativeNumber.optional(),
    marketCap: finiteNonNegativeNumber.optional(),
    price: finiteNonNegativeNumber.optional(),
    comment: z.union([z.string(), z.object({ comment: z.string() })]).optional(),
  })
  .passthrough();

export type RawActivity = z.infer<typeof rawActivitySchema>;
