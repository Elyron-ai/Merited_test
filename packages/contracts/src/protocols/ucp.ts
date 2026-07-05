import { z } from 'zod';
import { Money } from '../money.js';

/**
 * UCP payload contract stubs (PH3-2, §2.2 "fakes are contract stubs only").
 * The minimum shape both directions must agree on; the attribution token
 * rides ONLY the `com.merited.attribution` extension envelope — see
 * docs/spec/protocol-token-transport.md. Real-spec drift lands here first.
 */

export const UCP_EXTENSION_KEY = 'com.merited.attribution';

export const UcpAttributionExtension = z.object({
  token: z.string().min(1),
  quote_id: z.string(),
  expires_at: z.string().datetime(),
});
export type UcpAttributionExtension = z.infer<typeof UcpAttributionExtension>;

export const UcpOffer = z.object({
  type: z.literal('ucp.offer'),
  id: z.string(),
  title: z.string(),
  description: z.string(),
  price: z.object({ amount_minor: z.number().int().nonnegative(), currency: z.literal('GBP') }),
  seller_id: z.string(),
  valid_until: z.string().datetime(),
  /** Namespaced vendor-extension envelope (spec-legal free map). */
  extensions: z.record(z.unknown()).default({}),
});
export type UcpOffer = z.infer<typeof UcpOffer>;

export const UcpCheckoutCompleted = z.object({
  type: z.literal('ucp.checkout.completed'),
  checkout_id: z.string(),
  order: z.object({
    order_ref: z.string(),
    total: z.object({ amount_minor: z.number().int().nonnegative(), currency: z.literal('GBP') }),
    completed_at: z.string().datetime(),
    line_items: z.array(z.object({ sku: z.string(), quantity: z.number().int().positive() })),
    extensions: z.record(z.unknown()).default({}),
  }),
});
export type UcpCheckoutCompleted = z.infer<typeof UcpCheckoutCompleted>;

/** Total as contracts Money (integer pence — rule 3 of the mapping). */
export const ucpMoney = (money: Money): { amount_minor: number; currency: 'GBP' } => ({
  amount_minor: money.amount,
  currency: 'GBP',
});
