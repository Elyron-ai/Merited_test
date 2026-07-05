import type pg from 'pg';
import type { DeliveredEvent } from '@merited/events';
import { dataOf, type AnalyticsFragment } from './fragment.js';

/**
 * Internal ledger-derived index (PH1-19): commitment→merchant/bounty and
 * token→agent. Applied FIRST for every event, so the fragments that join
 * through it always see it caught up to the current event. Disposable like
 * every other projection table.
 */
export const indexes: AnalyticsFragment = {
  handles: ['CommitmentCreated', 'TokenMinted'],

  async apply(client: pg.ClientBase, event: DeliveredEvent): Promise<void> {
    if (event.type === 'CommitmentCreated') {
      const { commitment } = dataOf<{
        commitment: { commitment_id: string; merchant_id: string; bounty: unknown };
      }>(event);
      await client.query(
        `INSERT INTO core.analytics_commitments (commitment_id, merchant_id, bounty)
         VALUES ($1, $2, $3::jsonb) ON CONFLICT (commitment_id) DO NOTHING`,
        [commitment.commitment_id, commitment.merchant_id, JSON.stringify(commitment.bounty)],
      );
    } else if (event.type === 'TokenMinted') {
      const { claims } = dataOf<{ claims: { jti: string; aid: string; cid: string } }>(event);
      await client.query(
        `INSERT INTO core.analytics_tokens (jti, agent_id, commitment_id)
         VALUES ($1, $2, $3) ON CONFLICT (jti) DO NOTHING`,
        [claims.jti, claims.aid, claims.cid],
      );
    }
  },

  async reset(client: pg.ClientBase): Promise<void> {
    await client.query('DELETE FROM core.analytics_commitments');
    await client.query('DELETE FROM core.analytics_tokens');
    await client.query('DELETE FROM core.analytics_claims');
  },
};

/** merchant for a commitment, from the index ('(unknown)' pre-commitment). */
export const merchantForCommitment = async (
  client: pg.ClientBase,
  commitmentId: string,
): Promise<string> => {
  const { rows } = await client.query<{ merchant_id: string }>(
    'SELECT merchant_id FROM core.analytics_commitments WHERE commitment_id = $1',
    [commitmentId],
  );
  return rows[0]?.merchant_id ?? '(unknown)';
};

/** agent for a token, from the index (null when the jti was never minted). */
export const agentForToken = async (
  client: pg.ClientBase,
  jti: string | null,
): Promise<{ agent_id: string; commitment_id: string } | null> => {
  if (!jti) return null;
  const { rows } = await client.query<{ agent_id: string; commitment_id: string }>(
    'SELECT agent_id, commitment_id FROM core.analytics_tokens WHERE jti = $1',
    [jti],
  );
  return rows[0] ?? null;
};
