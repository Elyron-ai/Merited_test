import { z } from 'zod';

/**
 * ACP payload contract stubs (PH3-2, §2.2). ACP carries vendor data in a
 * flat string-map `metadata`; Merited keys are `merited:`-prefixed and the
 * attribution token rides ONLY `metadata["merited:token"]` — see
 * docs/spec/protocol-token-transport.md.
 */

export const ACP_TOKEN_KEY = 'merited:token';
export const ACP_QUOTE_KEY = 'merited:quote_id';
export const ACP_EXPIRES_KEY = 'merited:expires_at';

export const AcpItem = z.object({
  object: z.literal('acp.item'),
  id: z.string(),
  name: z.string(),
  description: z.string(),
  amount_minor: z.number().int().nonnegative(),
  currency: z.literal('gbp'),
  merchant: z.string(),
  metadata: z.record(z.string()).default({}),
});
export type AcpItem = z.infer<typeof AcpItem>;

export const AcpOrderWebhook = z.object({
  object: z.literal('acp.order'),
  id: z.string(),
  order_ref: z.string(),
  amount_minor: z.number().int().nonnegative(),
  currency: z.literal('gbp'),
  created_at: z.string().datetime(),
  line_items: z.array(z.object({ sku: z.string(), quantity: z.number().int().positive() })),
  metadata: z.record(z.string()).default({}),
});
export type AcpOrderWebhook = z.infer<typeof AcpOrderWebhook>;
