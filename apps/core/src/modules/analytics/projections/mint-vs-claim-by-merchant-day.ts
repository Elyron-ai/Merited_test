import type pg from 'pg';
import type { DeliveredEvent } from '@merited/events';
import { dataOf, dayOf, type AnalyticsFragment } from './fragment.js';
import { merchantForCommitment } from './indexes.js';

/**
 * `mint_vs_claim_by_merchant_day` (§5.9) — the under-reporting monitor's
 * feed (PH1-20; architecture §5: tokens minted vs claims arriving is THE
 * signal a merchant is quietly dropping webhooks). Mints attribute to the
 * merchant via the commitment index; claims/verdicts carry merchant_id.
 */
const bump = async (
  client: pg.ClientBase,
  merchantId: string,
  day: string,
  column: 'mints' | 'claims' | 'verified' | 'rejected',
): Promise<void> => {
  await client.query(
    `INSERT INTO core.mint_vs_claim_by_merchant_day (merchant_id, day, ${column})
     VALUES ($1, $2::date, 1)
     ON CONFLICT (merchant_id, day) DO UPDATE SET
       ${column} = core.mint_vs_claim_by_merchant_day.${column} + 1`,
    [merchantId, day],
  );
};

export const mintVsClaimByMerchantDay: AnalyticsFragment = {
  handles: ['TokenMinted', 'ConversionClaimed', 'ConversionVerified', 'ConversionRejected'],

  async apply(client: pg.ClientBase, event: DeliveredEvent): Promise<void> {
    if (event.type === 'TokenMinted') {
      const { claims } = dataOf<{ claims: { cid: string; iat: number } }>(event);
      const merchant = await merchantForCommitment(client, claims.cid);
      await bump(client, merchant, dayOf(new Date(claims.iat * 1000).toISOString()), 'mints');
    } else if (event.type === 'ConversionClaimed') {
      const data = dataOf<{ merchant_id: string; ts: string }>(event);
      await bump(client, data.merchant_id, dayOf(data.ts), 'claims');
    } else if (event.type === 'ConversionVerified') {
      const data = dataOf<{ merchant_id: string; verified_at: string }>(event);
      await bump(client, data.merchant_id, dayOf(data.verified_at), 'verified');
    } else {
      const data = dataOf<{ merchant_id: string; rejected_at: string }>(event);
      await bump(client, data.merchant_id, dayOf(data.rejected_at), 'rejected');
    }
  },

  async reset(client: pg.ClientBase): Promise<void> {
    await client.query('DELETE FROM core.mint_vs_claim_by_merchant_day');
  },
};
