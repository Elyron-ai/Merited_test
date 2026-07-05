import type pg from 'pg';
import type { DeliveredEvent, Projection } from '@merited/events';
import type { AnalyticsFragment } from './fragment.js';
import { budgetBurn } from './budget-burn.js';
import { conversionsByAgentDay } from './conversions-by-agent-day.js';
import { indexes } from './indexes.js';
import { mintVsClaimByMerchantDay } from './mint-vs-claim-by-merchant-day.js';
import { rejectionsByReasonDay } from './rejections-by-reason-day.js';

/**
 * The B19 analytics projection (PH1-19, §5.9): four ledger-driven read models
 * behind ONE registered projection — one cursor, one deterministic pass, so
 * the internal index and the tables it feeds are never differently caught up.
 * `indexes` applies first for every event, by construction. Rebuildable from
 * seq 0 (`pnpm analytics:rebuild`); the tables are disposable, the ledger
 * isn't.
 */
const fragments: readonly AnalyticsFragment[] = [
  indexes, // MUST be first — the others join through it
  conversionsByAgentDay,
  mintVsClaimByMerchantDay,
  rejectionsByReasonDay,
  budgetBurn,
];

export const analyticsProjection: Projection = {
  name: 'analytics_v1',
  handles: [...new Set(fragments.flatMap((fragment) => [...fragment.handles]))],

  async apply(client: pg.ClientBase, event: DeliveredEvent): Promise<void> {
    for (const fragment of fragments) {
      if (fragment.handles.includes(event.type)) await fragment.apply(client, event);
    }
  },

  async reset(client: pg.ClientBase): Promise<void> {
    for (const fragment of fragments) await fragment.reset(client);
  },
};

export { bountyFor } from './fragment.js';
