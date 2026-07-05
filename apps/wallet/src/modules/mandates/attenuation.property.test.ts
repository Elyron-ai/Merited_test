import { Mandate } from '@merited/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { attenuationViolations } from './attenuation.js';

/**
 * PH1-16 gate — "attenuated mandate cannot exceed any parent limit (property
 * test)" (§6.1). fast-check generators over scopes / limits / categories /
 * merchants prove the invariant holds structurally: whenever the predicate
 * accepts a child, that child does NOT exceed the parent on ANY dimension; and
 * widening any single dimension is always rejected.
 */
const CURRENCY = 'GBP_pence' as const;
const money = (amount: number) => ({ amount, currency: CURRENCY });
const iso = (days: number): string => new Date(Date.UTC(2026, 0, 1) + days * 86_400_000).toISOString();

const SCOPES = ['offers:read', 'loyalty:read', 'checkout:execute'] as const;
const CATEGORIES = ['spa', 'dining', 'yoga', 'retail'];
const MERCHANTS = ['mer_a', 'mer_b', 'mer_c', '*'];

const mandateArb: fc.Arbitrary<Mandate> = fc
  .record({
    scopes: fc.subarray([...SCOPES]),
    // three sorted amounts → pre_authorised ≤ per_txn ≤ per_month (superRefine)
    amounts: fc.tuple(fc.nat(1000), fc.nat(1000), fc.nat(1000)).map((t) => [...t].sort((a, b) => a - b)),
    categories: fc.subarray(CATEGORIES),
    merchants: fc.subarray(MERCHANTS, { minLength: 1 }),
    data_sharing: fc.record({ email: fc.boolean(), purchase_history: fc.boolean(), loyalty_ids: fc.boolean() }),
    expDays: fc.integer({ min: 1, max: 365 }),
  })
  .map((r) =>
    Mandate.parse({
      mandate_id: `mnd_${'0'.repeat(26)}`,
      consumer_ref: `usr_${'0'.repeat(26)}`,
      agent_id: `agt_${'0'.repeat(26)}`,
      scopes: r.scopes,
      limits: {
        per_txn: money(r.amounts[1]!),
        per_month: money(r.amounts[2]!),
        categories: r.categories,
      },
      merchants: r.merchants,
      data_sharing: r.data_sharing,
      pre_authorised_up_to: money(r.amounts[0]!),
      status: 'active',
      exp: iso(r.expDays),
      attestation: 'fake',
    }),
  );

describe('mandate attenuation invariant (PH1-16 gate, §6.1)', () => {
  it('accepting a child implies it does NOT exceed the parent on ANY dimension', () => {
    fc.assert(
      fc.property(mandateArb, mandateArb, (parent, child) => {
        if (attenuationViolations(parent, child).length !== 0) return; // only assert the accepted branch
        // every concrete dimension is within the parent's grant
        expect(child.scopes.every((s) => parent.scopes.includes(s))).toBe(true);
        expect(child.limits.per_txn.amount).toBeLessThanOrEqual(parent.limits.per_txn.amount);
        expect(child.limits.per_month.amount).toBeLessThanOrEqual(parent.limits.per_month.amount);
        expect(child.pre_authorised_up_to.amount).toBeLessThanOrEqual(parent.pre_authorised_up_to.amount);
        expect(child.limits.categories.every((c) => parent.limits.categories.includes(c))).toBe(true);
        const merchantsOk =
          parent.merchants.includes('*') ||
          (!child.merchants.includes('*') && child.merchants.every((m) => parent.merchants.includes(m)));
        expect(merchantsOk).toBe(true);
        for (const f of ['email', 'purchase_history', 'loyalty_ids'] as const) {
          if (child.data_sharing[f]) expect(parent.data_sharing[f]).toBe(true);
        }
        expect(Date.parse(child.exp)).toBeLessThanOrEqual(Date.parse(parent.exp));
      }),
      { numRuns: 1000 },
    );
  });

  it('a child equal to its parent is a valid attenuation (⊆, not strict ⊂)', () => {
    fc.assert(
      fc.property(mandateArb, (parent) => {
        expect(attenuationViolations(parent, { ...parent })).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it('widening EACH dimension is rejected on exactly that dimension', () => {
    const parent = Mandate.parse({
      mandate_id: `mnd_${'0'.repeat(26)}`,
      consumer_ref: `usr_${'0'.repeat(26)}`,
      agent_id: `agt_${'0'.repeat(26)}`,
      scopes: ['offers:read', 'checkout:execute'],
      limits: { per_txn: money(5000), per_month: money(20000), categories: ['spa', 'dining'] },
      merchants: ['mer_a', 'mer_b'],
      data_sharing: { email: true, purchase_history: false, loyalty_ids: false },
      pre_authorised_up_to: money(2000),
      status: 'active',
      exp: iso(30),
      attestation: 'fake',
    });
    const wider = (patch: Partial<Mandate>): Mandate => ({ ...parent, ...patch });
    expect(attenuationViolations(parent, wider({ scopes: ['offers:read', 'loyalty:read', 'checkout:execute'] }))).toContain('scopes');
    expect(attenuationViolations(parent, wider({ limits: { ...parent.limits, per_txn: money(6000) } }))).toContain('limits.per_txn');
    expect(attenuationViolations(parent, wider({ limits: { ...parent.limits, per_month: money(30000) } }))).toContain('limits.per_month');
    expect(attenuationViolations(parent, wider({ limits: { ...parent.limits, categories: ['spa', 'yoga'] } }))).toContain('limits.categories');
    expect(attenuationViolations(parent, wider({ merchants: ['mer_a', 'mer_c'] }))).toContain('merchants');
    expect(attenuationViolations(parent, wider({ merchants: ['*'] }))).toContain('merchants');
    expect(attenuationViolations(parent, wider({ pre_authorised_up_to: money(3000) }))).toContain('pre_authorised_up_to');
    expect(attenuationViolations(parent, wider({ data_sharing: { ...parent.data_sharing, loyalty_ids: true } }))).toContain('data_sharing.loyalty_ids');
    expect(attenuationViolations(parent, wider({ exp: iso(60) }))).toContain('exp');
  });

  it('a parent with merchants:["*"] permits any child merchant list', () => {
    fc.assert(
      fc.property(fc.subarray(MERCHANTS, { minLength: 1 }), (childMerchants) => {
        const parent = mandateArbWithMerchants(['*']);
        const child = { ...parent, merchants: childMerchants };
        expect(attenuationViolations(parent, child)).not.toContain('merchants');
      }),
      { numRuns: 100 },
    );
  });
});

const mandateArbWithMerchants = (merchants: string[]): Mandate =>
  Mandate.parse({
    mandate_id: `mnd_${'0'.repeat(26)}`,
    consumer_ref: `usr_${'0'.repeat(26)}`,
    agent_id: `agt_${'0'.repeat(26)}`,
    scopes: ['offers:read', 'checkout:execute'],
    limits: { per_txn: money(5000), per_month: money(20000), categories: ['spa'] },
    merchants,
    data_sharing: { email: true, purchase_history: true, loyalty_ids: true },
    pre_authorised_up_to: money(2000),
    status: 'active',
    exp: iso(30),
    attestation: 'fake',
  });
