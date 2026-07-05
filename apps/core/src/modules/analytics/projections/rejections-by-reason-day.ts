import type pg from 'pg';
import type { DeliveredEvent } from '@merited/events';
import { dataOf, dayOf, type AnalyticsFragment } from './fragment.js';
import { agentForToken } from './indexes.js';

/**
 * `rejections_by_reason_day` (§5.9; §3 "both sides must see WHY"): rejection
 * reason breakdowns queryable per merchant AND per agent. `BUDGET_EXHAUSTED`
 * lands here within one projection cycle (§5.6 downstream accept). The agent
 * resolves through the token index; '(unknown)' when the token itself was
 * unparseable (jti null on the event).
 */
export const rejectionsByReasonDay: AnalyticsFragment = {
  handles: ['ConversionRejected', 'OfferSuppressed'],

  async apply(client: pg.ClientBase, event: DeliveredEvent): Promise<void> {
    // PH2-1 (SYN-41): read-path guardrail suppressions land in the same
    // per-merchant/per-agent WHY table — §5.6's "BUDGET_EXHAUSTED visible in
    // analytics within one event-projection cycle" rides this row.
    if (event.type === 'OfferSuppressed') {
      const data = dataOf<{
        merchant_id: string;
        reason_code: string;
        agent_id: string | null;
        suppressed_at: string;
      }>(event);
      await client.query(
        `INSERT INTO core.rejections_by_reason_day (day, reason_code, merchant_id, agent_id, count)
         VALUES ($1::date, $2, $3, $4, 1)
         ON CONFLICT (day, reason_code, merchant_id, agent_id) DO UPDATE SET
           count = core.rejections_by_reason_day.count + 1`,
        [dayOf(data.suppressed_at), data.reason_code, data.merchant_id, data.agent_id ?? '(anonymous)'],
      );
      return;
    }
    const data = dataOf<{
      merchant_id: string;
      jti: string | null;
      reason_code: string;
      rejected_at: string;
    }>(event);
    const token = await agentForToken(client, data.jti);
    await client.query(
      `INSERT INTO core.rejections_by_reason_day (day, reason_code, merchant_id, agent_id, count)
       VALUES ($1::date, $2, $3, $4, 1)
       ON CONFLICT (day, reason_code, merchant_id, agent_id) DO UPDATE SET
         count = core.rejections_by_reason_day.count + 1`,
      [dayOf(data.rejected_at), data.reason_code, data.merchant_id, token?.agent_id ?? '(unknown)'],
    );
  },

  async reset(client: pg.ClientBase): Promise<void> {
    await client.query('DELETE FROM core.rejections_by_reason_day');
  },
};
