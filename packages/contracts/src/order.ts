import { z } from 'zod';
import { Money } from './money.js';

/**
 * Normalised order confirmation produced by a CommerceAdapter (BUILD-SPEC
 * §5.8). Basket contents are dropped upstream — hash + money numbers only
 * (architecture §2.4 data minimisation). `token` optional: a token-less
 * order is ordinary non-agent commerce and produces no claim (SYN-5/P2).
 */
export const OrderConfirmed = z.object({
  order_ref_hash: z.string(),
  gross_value: Money,
  token: z.string().optional(),
  ts: z.string().datetime(),
});

export type OrderConfirmed = z.infer<typeof OrderConfirmed>;
