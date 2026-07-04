import Link from 'next/link';
import { variantByType } from '../../../lib/mechanics-form';
import { getMerchantsService } from '../../../lib/platform';

export const dynamic = 'force-dynamic';

export default async function NewOffer({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const params = await searchParams;
  const variant = variantByType(params['type'] ?? '');
  const merchant = params['merchant'] ? await getMerchantsService().get(params['merchant']) : null;
  if (!variant || !merchant) {
    return (
      <main>
        <p><Link href="/offers">← Offers</Link></p>
        <p>Pick a merchant and a mechanics variant first.</p>
      </main>
    );
  }
  return (
    <main>
      <p><Link href="/offers">← Offers</Link></p>
      <h1>{`New ${variant.type} offer for ${merchant.name}`}</h1>
      <form action="/api/offers" method="post" style={{ display: 'grid', gap: '0.5rem', maxWidth: '28rem' }}>
        <input type="hidden" name="merchant_id" value={merchant.merchant_id} />
        <input type="hidden" name="type" value={variant.type} />
        <label>Title <input name="title" required style={{ width: '100%' }} /></label>
        <label>Description <textarea name="description" required style={{ width: '100%' }} /></label>
        <fieldset style={{ display: 'grid', gap: '0.5rem' }}>
          <legend>{`${variant.type} mechanics`}</legend>
          {variant.fields.map((field) => (
            <label key={field.name}>
              {field.label} <input name={`mech_${field.name}`} style={{ width: '100%' }} />
            </label>
          ))}
        </fieldset>
        <label>SKU scope (comma-separated, or the word all) <input name="sku_scope" defaultValue="all" required /></label>
        <label>Identity tiers (comma-separated of T1,T2,T3) <input name="identity_tiers" defaultValue="T1,T2,T3" required /></label>
        <label>Stacking group (blank = none) <input name="stacking_group" /></label>
        <label>Valid from (ISO) <input name="valid_from" defaultValue={new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')} required /></label>
        <label>Valid until (ISO) <input name="valid_until" required /></label>
        <button type="submit">Create draft</button>
      </form>
    </main>
  );
}
