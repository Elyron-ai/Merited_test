import {
  pence,
  type MerchantCommercial,
  type MeritedId,
  type Offer,
} from '@merited/contracts';

/**
 * Aurora Experiences seed fixtures (VAL-9, B22). Every ID is a FIXED,
 * hand-written ULID (D6 — no randomness in seed data; the demo asset must be
 * byte-stable across runs). Money numbers are D7's verbatim: bounty 1200
 * pence, take 2000 bps (£2.40), commission 6000 bps (£7.20), order gross
 * 8450 pence. ULID alphabet is Crockford base32 — no I, L, O or U anywhere
 * in the hand-written IDs.
 */

export const AURORA_MERCHANT_ID: MeritedId<'mer'> = 'mer_00SEEDAVR0RAEXPER1ENCE0001';

/** §10 step 1 verbatim: 20% take, 60% agent commission. */
export const AURORA_COMMERCIAL: MerchantCommercial = {
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  attribution_window_s: 86400,
  clawback_window_s: 2592000,
  budgets: { per_offer_default: null },
};

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
export const AURORA_MEMBERS: readonly AuroraMemberFixture[] = [
  {
    member_ref: 'am_seed_ada',
    sub_hash: '42416d287650fcd89bba65d6873d29f985b52c0e1dedf700c422187786c41699',
    loyalty_tier: 'Member',
    status: 'active',
  },
  {
    member_ref: 'am_seed_bea',
    sub_hash: '44d0f52c575a0c70c52955415e276d543ab9b2861a8006608f894819589915ce',
    loyalty_tier: 'Member',
    status: 'active',
  },
  {
    member_ref: 'am_seed_cyn',
    sub_hash: '375dab8032e90a1c46941e8e7edcbc1e908e981f95ff4f5d61759337493882bb',
    loyalty_tier: 'Gold',
    status: 'active',
  },
  {
    member_ref: 'am_seed_dev',
    sub_hash: 'b2ebc4723b479c5a660973e62c2103e713fcb93ee817ebb61f1b1df4e179af65',
    loyalty_tier: 'Gold',
    status: 'active',
  },
  {
    member_ref: 'am_seed_eve',
    sub_hash: 'dd3fbba65e68bfc3c6147f96f26b9bd6ab3cf9140c8abbb568c0f8185b16d51b',
    loyalty_tier: 'Gold',
    status: 'revoked',
  },
];

export interface AuroraOfferFixture {
  offer_id: MeritedId<'off'>;
  draft: Omit<Offer, 'offer_id' | 'status'>;
  /** Exactly ONE fixture carries this — the spa-day fixed CPA (D7). */
  bounty?: { type: 'fixed'; amount: ReturnType<typeof pence> };
}

/** Fixed validity window — the demo runs under a frozen clock (XC-5);
 * these dates keep serialised fixtures byte-identical across runs (D6). */
const VALID_FROM = '2026-07-01T00:00:00Z';
const VALID_UNTIL = '2027-06-30T00:00:00Z';

/**
 * 6 offers across 6 distinct `OfferMechanics` variants (row demands ≥4).
 * `sku_scope` values align exactly with FakeShop's seeded catalogue
 * (MER-11): sku_spa_day 8450 · sku_lunch 6200 · sku_massage 4500 ·
 * sku_yoga_class 1800 · sku_candle 2400. The spa-day pairing is D7's
 * arithmetic anchor: member_price 8450 == the catalogue list price, so the
 * quoted FINAL price is 8450 pence.
 */
export const AURORA_OFFERS: readonly AuroraOfferFixture[] = [
  {
    offer_id: 'off_00SEEDAVR0RA0FFER0SPADAY01',
    draft: {
      merchant_id: AURORA_MERCHANT_ID,
      title: 'Full spa day — Aurora Club price',
      description: 'A full spa day at Aurora Experiences at the Aurora Club member price.',
      mechanics: { type: 'member_price', sku_ref: 'sku_spa_day', price: pence(8450) },
      sku_scope: ['sku_spa_day'],
      identity_tiers: ['T1', 'T2', 'T3'],
      stacking_group: null,
      valid_from: VALID_FROM,
      valid_until: VALID_UNTIL,
    },
    bounty: { type: 'fixed', amount: pence(1200) }, // £12.00 — §10 step 1
  },
  {
    offer_id: 'off_00SEEDAVR0RA0FFER0PCT0FF02',
    draft: {
      merchant_id: AURORA_MERCHANT_ID,
      title: '10% off the tasting-menu lunch',
      description: 'Ten per cent off the tasting-menu lunch for two.',
      mechanics: { type: 'percentage_off', pct_bps: 1000 },
      sku_scope: ['sku_lunch'],
      identity_tiers: ['T1', 'T2', 'T3'],
      stacking_group: null,
      valid_from: VALID_FROM,
      valid_until: VALID_UNTIL,
    },
  },
  {
    offer_id: 'off_00SEEDAVR0RA0FFERFXD0FF003',
    draft: {
      merchant_id: AURORA_MERCHANT_ID,
      title: '£5 off the hot-stone massage',
      description: 'Five pounds off the hot-stone massage.',
      mechanics: { type: 'fixed_off', value: pence(500) },
      sku_scope: ['sku_massage'],
      identity_tiers: ['T1', 'T2'],
      stacking_group: null,
      valid_from: VALID_FROM,
      valid_until: VALID_UNTIL,
    },
  },
  {
    offer_id: 'off_00SEEDAVR0RA0FFERMB5Y0GA04',
    draft: {
      merchant_id: AURORA_MERCHANT_ID,
      title: 'Five sunrise yoga classes for £75',
      description: 'Book five sunrise yoga classes for seventy-five pounds.',
      mechanics: { type: 'multibuy_price', sku_ref: 'sku_yoga_class', qty: 5, total: pence(7500) },
      sku_scope: ['sku_yoga_class'],
      identity_tiers: ['T1', 'T2', 'T3'],
      stacking_group: null,
      valid_from: VALID_FROM,
      valid_until: VALID_UNTIL,
    },
  },
  {
    offer_id: 'off_00SEEDAVR0RA0FFERTHRESH005',
    draft: {
      merchant_id: AURORA_MERCHANT_ID,
      title: '£8 off when you spend £50',
      description: 'Eight pounds off any booking over fifty pounds.',
      mechanics: { type: 'threshold_discount', min_spend: pence(5000), value: pence(800) },
      sku_scope: 'all',
      identity_tiers: ['T1'],
      stacking_group: null,
      valid_from: VALID_FROM,
      valid_until: VALID_UNTIL,
    },
  },
  {
    offer_id: 'off_00SEEDAVR0RA0FFERPACKAGE06',
    draft: {
      merchant_id: AURORA_MERCHANT_ID,
      title: 'Massage and yoga bundle for £59',
      description: 'A hot-stone massage and a sunrise yoga class together for fifty-nine pounds.',
      mechanics: {
        type: 'bundle',
        sku_refs: ['sku_massage', 'sku_yoga_class'],
        value: pence(5900),
      },
      sku_scope: ['sku_massage', 'sku_yoga_class'],
      identity_tiers: ['T1', 'T2', 'T3'],
      stacking_group: null,
      valid_from: VALID_FROM,
      valid_until: VALID_UNTIL,
    },
  },
];

/** Control-plane admin (MER-7, seeded per its row). DEV credentials for the
 * internal single-team tool — the password and TOTP secret are deliberately
 * printable fixtures so the founder can sign in locally; production gets
 * real credentials at deployment, never through the seed. */
export const CONTROL_PLANE_ADMIN = {
  user_id: 'usr_00SEEDADM1NC0NTR0LPANE0001',
  email: 'admin@merited.test',
  password: 'aurora-admin-dev',
  totp_secret: 'GC6LROIAXSRZCWQ4FAH3K2SURHRZH7A2',
} as const;
