import type pg from 'pg';
import type { DeliveredEvent } from '@merited/events';
import { bountyFor, dataOf, dayOf, type AnalyticsFragment, type BountySpec } from './fragment.js';
import { agentForToken } from './indexes.js';

/**
 * `budget_burn` (§5.9): bounty burned per commitment per day. A verified
 * conversion burns its bounty (the trio's own formula, to the penny); a
 * reversal credits the SAME bounty back on the reversal's day (SYN-35 frees
 * budget exactly once — the claim→bounty index makes the credit exact). The
 * REMAINING budget is trio counter state (SYN-12), never a projection.
 */
const addBurn = async (
  client: pg.ClientBase,
  commitmentId: string,
  merchantId: string,
  day: string,
  deltaPence: number,
): Promise<void> => {
  await client.query(
    `INSERT INTO core.budget_burn (commitment_id, merchant_id, day, bounty_burned_pence)
     VALUES ($1, $2, $3::date, $4)
     ON CONFLICT (commitment_id, day) DO UPDATE SET
       bounty_burned_pence = core.budget_burn.bounty_burned_pence + $4`,
    [commitmentId, merchantId, day, deltaPence],
  );
};

export const budgetBurn: AnalyticsFragment = {
  handles: ['ConversionVerified', 'ConversionReversed'],

  async apply(client: pg.ClientBase, event: DeliveredEvent): Promise<void> {
    if (event.type === 'ConversionVerified') {
      const data = dataOf<{
        claim_id: string;
        merchant_id: string;
        jti: string;
        cid: string;
        gross_value: { amount: number };
        verified_at: string;
      }>(event);
      const { rows } = await client.query<{ bounty: BountySpec }>(
        'SELECT bounty FROM core.analytics_commitments WHERE commitment_id = $1',
        [data.cid],
      );
      const spec = rows[0]?.bounty;
      if (!spec) return; // commitment unseen — nothing to burn against
      const bounty = bountyFor(spec, data.gross_value.amount);
      const token = await agentForToken(client, data.jti);
      // claim→bounty index so a later reversal credits back exactly
      await client.query(
        `INSERT INTO core.analytics_claims (claim_id, commitment_id, agent_id, bounty_pence)
         VALUES ($1, $2, $3, $4) ON CONFLICT (claim_id) DO NOTHING`,
        [data.claim_id, data.cid, token?.agent_id ?? '(unknown)', bounty],
      );
      await addBurn(client, data.cid, data.merchant_id, dayOf(data.verified_at), bounty);
    } else {
      const data = dataOf<{ claim_id: string; merchant_id: string; reversed_at: string }>(event);
      const { rows } = await client.query<{ commitment_id: string; bounty_pence: string }>(
        'SELECT commitment_id, bounty_pence FROM core.analytics_claims WHERE claim_id = $1',
        [data.claim_id],
      );
      const claim = rows[0];
      if (!claim) return; // reversal of a conversion this ledger never verified
      await addBurn(client, claim.commitment_id, data.merchant_id, dayOf(data.reversed_at), -Number(claim.bounty_pence));
    }
  },

  async reset(client: pg.ClientBase): Promise<void> {
    await client.query('DELETE FROM core.budget_burn');
  },
};
