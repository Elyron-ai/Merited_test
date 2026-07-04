import { Offer } from '@merited/contracts';
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { offerCommitments, offerCounters, offers } from './schema.js';

const isoS = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

type OfferRow = typeof offers.$inferSelect;

/** Row → contract shape, re-validated at the READ boundary too (§5.1: the
 * union guards every boundary, so a hand-edited row cannot leak out). */
const toOffer = (row: OfferRow): Offer =>
  Offer.parse({
    offer_id: row.offer_id,
    merchant_id: row.merchant_id,
    title: row.title,
    description: row.description,
    mechanics: row.mechanics,
    sku_scope: row.sku_scope,
    identity_tiers: row.identity_tiers,
    stacking_group: row.stacking_group,
    status: row.status,
    valid_from: isoS(row.valid_from),
    valid_until: isoS(row.valid_until),
  });

export interface OfferRecord {
  offer: Offer;
  current_commitment_id: string | null;
}

/**
 * Offers repository (CORE-2): plain data access over core.offers +
 * counters + COR history. No HTTP here — the control plane consumes the
 * service; the read path consumes this repository.
 */
export class OffersRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async insert(offer: Offer): Promise<void> {
    const parsed = Offer.parse(offer); // write boundary (§5.1)
    await this.db.transaction(async (tx) => {
      await tx.insert(offers).values({
        offer_id: parsed.offer_id,
        merchant_id: parsed.merchant_id,
        title: parsed.title,
        description: parsed.description,
        mechanics: parsed.mechanics,
        sku_scope: parsed.sku_scope,
        identity_tiers: parsed.identity_tiers,
        stacking_group: parsed.stacking_group,
        status: parsed.status,
        valid_from: new Date(parsed.valid_from),
        valid_until: new Date(parsed.valid_until),
      });
      await tx.insert(offerCounters).values({ offer_id: parsed.offer_id });
    });
  }

  async update(offer: Offer): Promise<boolean> {
    const parsed = Offer.parse(offer); // write boundary (§5.1)
    const updated = await this.db
      .update(offers)
      .set({
        title: parsed.title,
        description: parsed.description,
        mechanics: parsed.mechanics,
        sku_scope: parsed.sku_scope,
        identity_tiers: parsed.identity_tiers,
        stacking_group: parsed.stacking_group,
        valid_from: new Date(parsed.valid_from),
        valid_until: new Date(parsed.valid_until),
        updated_at: sql`now()`,
      })
      .where(eq(offers.offer_id, parsed.offer_id))
      .returning({ offer_id: offers.offer_id });
    return updated.length === 1;
  }

  async get(offerId: string): Promise<OfferRecord | null> {
    const rows = await this.db.select().from(offers).where(eq(offers.offer_id, offerId));
    const row = rows[0];
    if (!row) return null;
    return { offer: toOffer(row), current_commitment_id: row.current_commitment_id };
  }

  async list(filter: { merchantId?: string; status?: Offer['status'] } = {}): Promise<Offer[]> {
    const conditions: SQL[] = [];
    if (filter.merchantId) conditions.push(eq(offers.merchant_id, filter.merchantId));
    if (filter.status) conditions.push(eq(offers.status, filter.status));
    const rows = conditions.length
      ? await this.db.select().from(offers).where(and(...conditions)).orderBy(offers.offer_id)
      : await this.db.select().from(offers).orderBy(offers.offer_id);
    return rows.map(toOffer);
  }

  /** Guarded status transition; false when the offer is not in `expect`. */
  async setStatus(
    offerId: string,
    next: Offer['status'],
    expect: readonly Offer['status'][],
  ): Promise<boolean> {
    const updated = await this.db
      .update(offers)
      .set({ status: next, updated_at: sql`now()` })
      .where(and(eq(offers.offer_id, offerId), inArray(offers.status, [...expect])))
      .returning({ offer_id: offers.offer_id });
    return updated.length === 1;
  }

  async redeemCount(offerId: string): Promise<number> {
    const rows = await this.db
      .select({ redeem_count: offerCounters.redeem_count })
      .from(offerCounters)
      .where(eq(offerCounters.offer_id, offerId));
    return rows[0]?.redeem_count ?? 0;
  }

  /** Read-path candidate fetch (CORE-11, §4): live offers matching the
   * query, with their current COR reference. Ph0 text search is plain
   * ILIKE over title/description — no search infra (§11 restraint). */
  async listCandidates(query: {
    merchantId?: string;
    sku?: string;
    text?: string;
    offerId?: string;
  }): Promise<Array<{ offer: Offer; commitment_id: `com_${string}` | null }>> {
    const conditions: SQL[] = [eq(offers.status, 'live')];
    if (query.offerId) conditions.push(eq(offers.offer_id, query.offerId));
    if (query.merchantId) conditions.push(eq(offers.merchant_id, query.merchantId));
    if (query.sku) {
      conditions.push(
        sql`(${offers.sku_scope} = to_jsonb('all'::text) OR ${offers.sku_scope} @> jsonb_build_array(${query.sku}::text))`,
      );
    }
    if (query.text) {
      const needle = `%${query.text.replace(/[%_]/g, '\\$&')}%`;
      conditions.push(sql`(${offers.title} ILIKE ${needle} OR ${offers.description} ILIKE ${needle})`);
    }
    const rows = await this.db.select().from(offers).where(and(...conditions)).orderBy(offers.offer_id);
    return rows.map((row) => ({
      offer: toOffer(row),
      commitment_id: row.current_commitment_id as `com_${string}` | null,
    }));
  }

  /** COR history rows for an offer (CORE-5 appends; "history preserved"). */
  async commitmentHistory(
    offerId: string,
  ): Promise<Array<{ commitment_id: string; ended_at: Date | null }>> {
    return this.db
      .select({ commitment_id: offerCommitments.commitment_id, ended_at: offerCommitments.ended_at })
      .from(offerCommitments)
      .where(eq(offerCommitments.offer_id, offerId))
      .orderBy(offerCommitments.created_at);
  }
}
