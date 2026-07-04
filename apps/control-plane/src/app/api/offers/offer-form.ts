import { parseMechanicsForm } from '../../../lib/mechanics-form';

/** The shared offer-form parser: mechanics via the generated union form,
 * scope/tiers as comma lists, everything trimmed — floats never pass. */
export const offerFields = (form: FormData) => {
  const scopeRaw = String(form.get('sku_scope') ?? '').trim();
  return {
    title: String(form.get('title') ?? '').trim(),
    description: String(form.get('description') ?? '').trim(),
    mechanics: parseMechanicsForm(String(form.get('type') ?? ''), form),
    sku_scope: scopeRaw === 'all' ? ('all' as const) : scopeRaw.split(',').map((s) => s.trim()).filter(Boolean),
    identity_tiers: String(form.get('identity_tiers') ?? '').split(',').map((t) => t.trim()).filter(Boolean) as ('T1' | 'T2' | 'T3')[],
    stacking_group: String(form.get('stacking_group') ?? '').trim() || null,
    valid_from: String(form.get('valid_from') ?? '').trim(),
    valid_until: String(form.get('valid_until') ?? '').trim(),
  };
};
