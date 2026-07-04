import { createHash } from 'node:crypto';
import { Id, MerchantCommercial, Offer } from '@merited/contracts';
import { CATALOGUE, skuByRef } from '@merited/fake-aurora';
import { describe, expect, it } from 'vitest';
import { AURORA_COMMERCIAL, AURORA_MEMBERS, AURORA_MERCHANT_ID, AURORA_OFFERS } from './aurora.js';

describe('Aurora fixtures (VAL-9 accept — all fixtures Zod-parse from @merited/contracts)', () => {
  it('merchant ID and commercial config parse; §10 step 1 numbers verbatim (20% / 60%)', () => {
    expect(Id('mer').parse(AURORA_MERCHANT_ID)).toBe(AURORA_MERCHANT_ID);
    const commercial = MerchantCommercial.parse(AURORA_COMMERCIAL);
    expect(commercial.take_rate_bps).toBe(2000);
    expect(commercial.agent_commission_bps).toBe(6000);
  });

  it('every offer fixture parses as a draft Offer with its FIXED ULID (D6)', () => {
    for (const fixture of AURORA_OFFERS) {
      const offer = Offer.parse({ ...fixture.draft, offer_id: fixture.offer_id, status: 'draft' });
      expect(offer.offer_id).toBe(fixture.offer_id);
      expect(offer.merchant_id).toBe(AURORA_MERCHANT_ID);
    }
    // fixed IDs are unique
    expect(new Set(AURORA_OFFERS.map((f) => f.offer_id)).size).toBe(AURORA_OFFERS.length);
  });

  it('6 offers spanning ≥4 distinct mechanics variants; exactly ONE fixed CPA bounty of 1200 pence', () => {
    expect(AURORA_OFFERS).toHaveLength(6);
    const variants = new Set(AURORA_OFFERS.map((f) => f.draft.mechanics.type));
    expect(variants.size).toBeGreaterThanOrEqual(4);
    const bountied = AURORA_OFFERS.filter((f) => f.bounty);
    expect(bountied).toHaveLength(1);
    expect(bountied[0]!.bounty).toMatchObject({ type: 'fixed', amount: { amount: 1200, currency: 'GBP_pence' } });
    expect(bountied[0]!.draft.mechanics.type).toBe('member_price'); // the spa day
  });

  it('D7 arithmetic anchor: spa-day member price equals the catalogue list price → final 8450; splits 720/240/240', () => {
    const spa = AURORA_OFFERS.find((f) => f.bounty)!;
    const mechanics = spa.draft.mechanics as { type: 'member_price'; sku_ref: string; price: { amount: number } };
    expect(mechanics.price.amount).toBe(8450);
    expect(skuByRef(mechanics.sku_ref)?.price_pence).toBe(8450);
    // bounty splits derived from the seeded config are §10's exact pennies
    const bounty = spa.bounty!.amount.amount;
    expect((bounty * AURORA_COMMERCIAL.agent_commission_bps) / 10000).toBe(720); // agent £7.20
    expect((bounty * AURORA_COMMERCIAL.take_rate_bps) / 10000).toBe(240); // Merited £2.40
    expect(bounty - 720 - 240).toBe(240); // reserve £2.40
  });

  it('every sku_scope entry names a real FakeShop catalogue SKU', () => {
    const known = new Set(CATALOGUE.map((s) => s.sku));
    for (const fixture of AURORA_OFFERS) {
      if (fixture.draft.sku_scope === 'all') continue;
      for (const sku of fixture.draft.sku_scope) expect(known.has(sku), `${sku} not in catalogue`).toBe(true);
    }
  });

  it('members span Member + Gold tiers with one revoked row; sub_hashes are the documented sha256s', () => {
    const tiers = new Set(AURORA_MEMBERS.map((m) => m.loyalty_tier));
    expect(tiers).toEqual(new Set(['Member', 'Gold']));
    expect(AURORA_MEMBERS.filter((m) => m.status === 'revoked')).toHaveLength(1);
    for (const member of AURORA_MEMBERS) {
      const expected = createHash('sha256').update(`aurora-club:${member.member_ref}`).digest('hex');
      expect(member.sub_hash).toBe(expected);
    }
  });
});
