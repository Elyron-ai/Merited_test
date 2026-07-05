import { describe, expect, it } from 'vitest';
import { ruleFromForm } from '../src/lib/rules-form';

const form = (fields: Record<string, string>): FormData => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

describe('exclusion-rule form parsing (PH1-3)', () => {
  const merchant = 'mer_00000000000000000000000001' as const;

  it('builds each rule kind; empty selects become nulls', () => {
    expect(
      ruleFromForm(merchant, form({ type: 'merchant_agent_exclusion', agent_id: 'agt_00000000000000000000000001' })),
    ).toEqual({
      type: 'merchant_agent_exclusion',
      merchant_id: merchant,
      agent_id: 'agt_00000000000000000000000001',
      note: null,
    });
    expect(
      ruleFromForm(merchant, form({ type: 'merchant_tier_exclusion', tier: 'T1', segment: '', note: 'no T1' })),
    ).toEqual({ type: 'merchant_tier_exclusion', merchant_id: merchant, tier: 'T1', segment: null, note: 'no T1' });
    expect(ruleFromForm(merchant, form({ type: 'merchant_sku_exclusion', sku_ref: 'sku_spa_day' }))).toEqual({
      type: 'merchant_sku_exclusion',
      merchant_id: merchant,
      sku_ref: 'sku_spa_day',
      note: null,
    });
  });

  it('unknown kinds refuse', () => {
    expect(() => ruleFromForm(merchant, form({ type: 'nonsense' }))).toThrow("unknown rule kind");
  });
});
