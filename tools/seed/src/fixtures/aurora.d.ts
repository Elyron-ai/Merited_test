import { pence, type MerchantCommercial, type MeritedId, type Offer } from '@merited/contracts';
/**
 * Aurora Experiences seed fixtures (VAL-9, B22). Every ID is a FIXED,
 * hand-written ULID (D6 — no randomness in seed data; the demo asset must be
 * byte-stable across runs). Money numbers are D7's verbatim: bounty 1200
 * pence, take 2000 bps (£2.40), commission 6000 bps (£7.20), order gross
 * 8450 pence. ULID alphabet is Crockford base32 — no I, L, O or U anywhere
 * in the hand-written IDs.
 */
export declare const AURORA_MERCHANT_ID: MeritedId<'mer'>;
/** §10 step 1 verbatim: 20% take, 60% agent commission. */
export declare const AURORA_COMMERCIAL: MerchantCommercial;
export interface AuroraMemberFixture {
    member_ref: string;
    /** Phase-0 seeded-T1 handle: Valet passes this as `sub_hash` (§5.3). */
    sub_hash: string;
    loyalty_tier: 'Member' | 'Gold';
    status: 'active' | 'revoked';
}
/** Fixed sub_hashes (sha256 of `aurora-club:<ref>`, precomputed — D6). A
 * revoked Gold row is seeded deliberately: it must NEVER resolve T1
 * (CORE-4's downgrade semantics, rehearsing B23). */
export declare const AURORA_MEMBERS: readonly AuroraMemberFixture[];
export interface AuroraOfferFixture {
    offer_id: MeritedId<'off'>;
    draft: Omit<Offer, 'offer_id' | 'status'>;
    /** Exactly ONE fixture carries this — the spa-day fixed CPA (D7). */
    bounty?: {
        type: 'fixed';
        amount: ReturnType<typeof pence>;
    };
}
/**
 * 6 offers across 6 distinct `OfferMechanics` variants (row demands ≥4).
 * `sku_scope` values align exactly with FakeShop's seeded catalogue
 * (MER-11): sku_spa_day 8450 · sku_lunch 6200 · sku_massage 4500 ·
 * sku_yoga_class 1800 · sku_candle 2400. The spa-day pairing is D7's
 * arithmetic anchor: member_price 8450 == the catalogue list price, so the
 * quoted FINAL price is 8450 pence.
 */
export declare const AURORA_OFFERS: readonly AuroraOfferFixture[];
/** Control-plane admin (MER-7, seeded per its row). DEV credentials for the
 * internal single-team tool — the password and TOTP secret are deliberately
 * printable fixtures so the founder can sign in locally; production gets
 * real credentials at deployment, never through the seed. */
export declare const CONTROL_PLANE_ADMIN: {
    readonly user_id: "usr_00SEEDADM1NC0NTR0LPANE0001";
    readonly email: "admin@merited.test";
    readonly password: "aurora-admin-dev";
    readonly totp_secret: "GC6LROIAXSRZCWQ4FAH3K2SURHRZH7A2";
};
//# sourceMappingURL=aurora.d.ts.map