import type pg from 'pg';
import type { DeliveredEvent } from '@merited/events';
import { dataOf, dayOf, type AnalyticsFragment } from './fragment.js';
import { agentForToken } from './indexes.js';

/**
 * `conversions_by_agent_day` (§5.9): verified conversions + gross per agent
 * per day. The agent comes from the minted token's claims (jti→aid index) —
 * ConversionVerified itself carries no agent, by design (SYN-8: the trio's
 * mint record is authoritative).
 */
export const conversionsByAgentDay: AnalyticsFragment = {
  handles: ['ConversionVerified'],

  async apply(client: pg.ClientBase, event: DeliveredEvent): Promise<void> {
    const data = dataOf<{ jti: string; gross_value: { amount: number }; verified_at: string }>(event);
    const token = await agentForToken(client, data.jti);
    await client.query(
      `INSERT INTO core.conversions_by_agent_day (agent_id, day, conversions, gross_pence)
       VALUES ($1, $2::date, 1, $3)
       ON CONFLICT (agent_id, day) DO UPDATE SET
         conversions = core.conversions_by_agent_day.conversions + 1,
         gross_pence = core.conversions_by_agent_day.gross_pence + $3`,
      [token?.agent_id ?? '(unknown)', dayOf(data.verified_at), data.gross_value.amount],
    );
  },

  async reset(client: pg.ClientBase): Promise<void> {
    await client.query('DELETE FROM core.conversions_by_agent_day');
  },
};
