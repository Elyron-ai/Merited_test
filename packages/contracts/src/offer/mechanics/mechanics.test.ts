import { describe, expect, it } from 'vitest';
import { ALL_MECHANICS, OfferMechanics } from './index.js';
import { MECHANICS_FIXTURES } from './fixtures.js';

describe('OfferMechanics union (FND-5 accept, maps §5.1)', () => {
  it('has exactly 27 discriminants (exhaustiveness meta-test)', () => {
    expect(ALL_MECHANICS).toHaveLength(27);
    const types = ALL_MECHANICS.map((s) => s.shape.type.value);
    expect(new Set(types).size).toBe(27);
  });

  it('the 7 spec-named variants are present verbatim', () => {
    const types = new Set(ALL_MECHANICS.map((s) => s.shape.type.value));
    for (const specNamed of [
      'percentage_off',
      'fixed_off',
      'points_multiplier',
      'points_bonus',
      'tier_unlock',
      'welcome_bonus',
      'bundle',
    ]) {
      expect(types.has(specNamed as never)).toBe(true);
    }
  });

  it('all 27 mechanics round-trip through Zod (one fixture per variant)', () => {
    expect(MECHANICS_FIXTURES).toHaveLength(27);
    const fixtureTypes = new Set(MECHANICS_FIXTURES.map((f) => f.type));
    expect(fixtureTypes.size).toBe(27);
    for (const fixture of MECHANICS_FIXTURES) {
      const parsed = OfferMechanics.parse(fixture);
      const reparsed = OfferMechanics.parse(JSON.parse(JSON.stringify(parsed)));
      expect(reparsed).toEqual(fixture);
    }
  });

  it('rejects unknown type', () => {
    expect(OfferMechanics.safeParse({ type: 'mystery_discount', pct_bps: 100 }).success).toBe(false);
    expect(OfferMechanics.safeParse({ type: 'percentage_off' }).success).toBe(false); // missing field
  });

  it('every variant has ≤ 5 fields including type (§3: "if a variant needs more, it\'s two variants")', () => {
    for (const schema of ALL_MECHANICS) {
      const keyCount = Object.keys(schema.shape).length;
      expect(keyCount, `${schema.shape.type.value} has ${keyCount} keys`).toBeLessThanOrEqual(5);
    }
  });

  it('numeric fields are integers only (no float bps/multipliers)', () => {
    expect(OfferMechanics.safeParse({ type: 'percentage_off', pct_bps: 15.5 }).success).toBe(false);
    expect(
      OfferMechanics.safeParse({ type: 'points_multiplier', multiplier_x100: 1.5 }).success,
    ).toBe(false);
    expect(
      OfferMechanics.safeParse({ type: 'fixed_off', value: { amount: 5.5, currency: 'GBP_pence' } })
        .success,
    ).toBe(false);
  });
});
