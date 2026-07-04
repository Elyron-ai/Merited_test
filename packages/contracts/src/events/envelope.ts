import { z } from 'zod';

/**
 * Event body envelope (FND D2/D9): `{ type, v: 1, data }`. Type and schema
 * version live INSIDE the body so both are covered by the hash chain; the
 * ledger's `type` column merely duplicates `body.type` for indexing.
 */
export const eventBody = <T extends string, D extends z.ZodTypeAny>(type: T, data: D) =>
  z.object({
    type: z.literal(type),
    v: z.literal(1),
    data,
  });

export type EventBody<T extends string = string> = {
  type: T;
  v: 1;
  data: unknown;
};
