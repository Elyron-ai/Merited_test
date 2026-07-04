import { z } from 'zod';

/**
 * Money is integer pence, always (BUILD-SPEC §0.4, §3). Never floats,
 * never another currency literal.
 */
export const Money = z.object({
  amount: z.number().int().nonnegative(),
  currency: z.literal('GBP_pence'),
});

export type Money = z.infer<typeof Money>;

/** Convenience constructor for integer pence. */
export const pence = (amount: number): Money => Money.parse({ amount, currency: 'GBP_pence' });
