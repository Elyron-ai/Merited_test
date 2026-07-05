import { z } from 'zod';

/**
 * Ledger head publication record (PH1-1 → PH1-21, architecture §2.6:
 * "simplest credible external anchor"). One per day: the chain's head at
 * publication time. A third party holding yesterday's record can verify
 * today's ledger grew append-only from it (PH3-7/8 build on this).
 */
export const HeadPublication = z.object({
  /** Publication day, UTC calendar date. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Ledger sequence number the head covers (inclusive). */
  seq: z.number().int().nonnegative(),
  /** The chain head at `seq` — lowercase sha256 hex. */
  head_hash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type HeadPublication = z.infer<typeof HeadPublication>;
