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

/**
 * Decimal money string ("84.50") → integer pence, by STRING maths — a float
 * never touches a monetary value (§0.4). Strict two-decimal form only; the
 * commerce boundary (Shopify totals) is the consumer.
 */
export const poundsToPence = (decimal: string): number => {
  const match = /^(\d+)\.(\d{2})$/.exec(decimal);
  if (!match) throw new Error(`not a 2dp decimal money string: ${decimal}`);
  return Number(match[1]) * 100 + Number(match[2]);
};

/** Integer pence → decimal money string ("84.50"), by string maths. */
export const penceToPounds = (amountPence: number): string => {
  if (!Number.isInteger(amountPence) || amountPence < 0) {
    throw new Error(`not non-negative integer pence: ${amountPence}`);
  }
  const whole = String(amountPence).slice(0, -2) || '0';
  const fraction = String(amountPence).padStart(2, '0').slice(-2);
  return `${whole}.${fraction}`;
};
