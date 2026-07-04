import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Mandate } from '../mandate.js';
import { Money } from '../money.js';
import { OfferMechanics } from '../offer/mechanics/index.js';
import {
  arbMandate,
  arbMandateOrderingViolation,
  arbMandateTree,
  arbMechanics,
  arbMoney,
  mechanicsArbitraries,
} from './arbitraries.js';

/** Registry: docs/testing/property-registry.md (XC-6). Seeds fixed — a
 * property failure must reproduce, not flake. */
const RUNS = { numRuns: 200, seed: 2026 };

describe('P-1 — offer mechanics round-trip (§5.1)', () => {
  it('generation covers every union variant — a 28th variant is generated automatically', () => {
    const generated = new Set(mechanicsArbitraries().keys());
    const union = new Set(
      OfferMechanics.options.map((o) => (o.shape as { type: { value: string } }).type.value),
    );
    expect(generated).toEqual(union);
    expect(generated.size).toBe(27);
  });

  it('parse(serialise(x)) ≡ x for arbitrary mechanics of every variant', () => {
    fc.assert(
      fc.property(arbMechanics(), (mechanics) => {
        const revived = OfferMechanics.parse(JSON.parse(JSON.stringify(mechanics)));
        expect(revived).toEqual(mechanics);
      }),
      RUNS,
    );
  });

  it('each variant round-trips individually (no variant hides behind oneof frequencies)', () => {
    for (const [type, arbitrary] of mechanicsArbitraries()) {
      fc.assert(
        fc.property(arbitrary, (mechanics) => {
          expect(mechanics.type).toBe(type);
          expect(OfferMechanics.parse(JSON.parse(JSON.stringify(mechanics)))).toEqual(mechanics);
        }),
        { numRuns: 25, seed: 2026 },
      );
    }
  });
});

describe('P-8 — Money closed over non-negative integer pence (§0.4)', () => {
  it('any generated Money parses; addition of amounts stays valid Money', () => {
    fc.assert(
      fc.property(arbMoney(), arbMoney(), (a, b) => {
        expect(Money.parse(a)).toEqual(a);
        const sum = { amount: a.amount + b.amount, currency: 'GBP_pence' as const };
        expect(Money.parse(sum)).toEqual(sum);
      }),
      RUNS,
    );
  });

  it('no float ever enters a Money — any fractional amount is refused', () => {
    const arbFloat = fc
      .double({ min: 0, max: 1_000_000, noNaN: true, noDefaultInfinity: true })
      .filter((v) => !Number.isInteger(v));
    fc.assert(
      fc.property(arbFloat, (amount) => {
        expect(() => Money.parse({ amount, currency: 'GBP_pence' })).toThrow();
      }),
      RUNS,
    );
  });
});

describe('P-3 — mandate attenuation, Phase 0 half (§6.1)', () => {
  it('any generated mandate with ordered limits is valid; child of a tree never exceeds its parent', () => {
    fc.assert(
      fc.property(arbMandate(), (mandate) => {
        expect(Mandate.parse(mandate)).toEqual(mandate);
      }),
      RUNS,
    );
    fc.assert(
      fc.property(arbMandateTree(), ({ parent, child }) => {
        expect(Mandate.parse(child)).toEqual(child);
        expect(child.limits.per_txn.amount).toBeLessThanOrEqual(parent.limits.per_txn.amount);
        expect(child.limits.per_month.amount).toBeLessThanOrEqual(parent.limits.per_month.amount);
        expect(child.pre_authorised_up_to.amount).toBeLessThanOrEqual(
          parent.pre_authorised_up_to.amount,
        );
      }),
      RUNS,
    );
  });

  it('widening is a validation error by construction — any ordering violation is refused', () => {
    fc.assert(
      fc.property(arbMandateOrderingViolation(), (violation) => {
        expect(() => Mandate.parse(violation)).toThrow();
      }),
      RUNS,
    );
  });
});
