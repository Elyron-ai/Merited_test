import type { MeritedId } from '@merited/contracts';
import type { EligibilityRuleDraft } from '@merited/core';

/** Build a rule draft from the posted form; validation happens in
 * RulesStore.add via the contract union (single source of truth). */
export const ruleFromForm = (merchantId: MeritedId<'mer'>, form: FormData): EligibilityRuleDraft => {
  const type = String(form.get('type') ?? '');
  const text = (name: string): string | null => {
    const value = String(form.get(name) ?? '').trim();
    return value === '' ? null : value;
  };
  const note = text('note');
  switch (type) {
    case 'merchant_agent_exclusion':
      return { type, merchant_id: merchantId, agent_id: text('agent_id') ?? '', note } as never;
    case 'merchant_tier_exclusion':
      return { type, merchant_id: merchantId, tier: text('tier'), segment: text('segment'), note } as never;
    case 'merchant_sku_exclusion':
      return { type, merchant_id: merchantId, sku_ref: text('sku_ref') ?? '', note } as never;
    default:
      throw new Error(`unknown rule kind '${type}'`);
  }
};
