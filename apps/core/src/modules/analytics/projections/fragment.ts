import type pg from 'pg';
import type { DeliveredEvent } from '@merited/events';

/**
 * One slice of the composite analytics projection (PH1-19). Fragments share
 * a SINGLE registered projection (one cursor, one deterministic pass over the
 * ledger) so cross-fragment lookups — commitment→merchant, token→agent,
 * claim→bounty — are always exactly as caught-up as the tables they feed.
 */
export interface AnalyticsFragment {
  handles: readonly string[];
  apply(client: pg.ClientBase, event: DeliveredEvent): Promise<void>;
  reset(client: pg.ClientBase): Promise<void>;
}

/** The ledger stores bodies as `{type, v, data}` — data is the payload. */
export const dataOf = <T>(event: DeliveredEvent): T => (event.body as { data: T }).data;

/** Day (UTC date string) a body datetime falls on. */
export const dayOf = (datetime: string): string => datetime.slice(0, 10);

export interface BountySpec {
  type: 'fixed' | 'pct_of_order';
  amount?: { amount: number; currency: string };
  pct_bps?: number;
}

/** Bounty for a conversion — the trio's own formula (posting.ts), to the penny. */
export const bountyFor = (bounty: BountySpec, grossPence: number): number =>
  bounty.type === 'fixed' ? bounty.amount!.amount : Math.floor((grossPence * bounty.pct_bps!) / 10000);
