import Link from 'next/link';
import { variantByType } from '../../../lib/mechanics-form';
import { getPool } from '../../../lib/db';
import { getOffersStack } from '../../../lib/platform';

export const dynamic = 'force-dynamic';

export default async function OfferDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const record = await getOffersStack().repository.get(id);
  if (!record) {
    return (
      <main><p><Link href="/offers">← Offers</Link></p><p>No such offer.</p></main>
    );
  }
  const { offer, current_commitment_id } = record;
  const variant = variantByType(offer.mechanics.type)!;
  const mechanics = offer.mechanics as unknown as Record<string, unknown>;

  const { rows: corHistory } = await getPool().query<{ commitment_id: string; created_at: Date }>(
    `SELECT commitment_id, created_at FROM core.offer_commitments WHERE offer_id = $1 ORDER BY created_at`,
    [id],
  );
  const { rows: corEvents } = await getPool().query<{ commitment: Record<string, unknown> }>(
    `SELECT body->'data'->'commitment' AS commitment FROM events.events
      WHERE type = 'CommitmentCreated' AND body->'data'->'commitment'->>'offer_ref' = $1
      ORDER BY seq`,
    [id],
  );

  const fieldDefault = (name: string): string => {
    const value = mechanics[name];
    if (value === null || value === undefined) return '';
    if (typeof value === 'object' && 'amount' in (value as object)) return String((value as { amount: number }).amount);
    if (Array.isArray(value)) return value.join(', ');
    return String(value);
  };

  return (
    <main>
      <p><Link href="/offers">← Offers</Link></p>
      <h1>{offer.title}</h1>
      <p>Status: <strong>{offer.status}</strong> · Mechanics: <code>{offer.mechanics.type}</code></p>

      <h2>Edit</h2>
      <form action={`/api/offers/${offer.offer_id}`} method="post" style={{ display: 'grid', gap: '0.5rem', maxWidth: '28rem' }}>
        <input type="hidden" name="type" value={offer.mechanics.type} />
        <label>Title <input name="title" defaultValue={offer.title} required /></label>
        <label>Description <textarea name="description" defaultValue={offer.description} required /></label>
        <fieldset style={{ display: 'grid', gap: '0.5rem' }}>
          <legend>{`${offer.mechanics.type} mechanics`}</legend>
          {variant.fields.map((field) => (
            <label key={field.name}>
              {field.label} <input name={`mech_${field.name}`} defaultValue={fieldDefault(field.name)} />
            </label>
          ))}
        </fieldset>
        <label>SKU scope <input name="sku_scope" defaultValue={offer.sku_scope === 'all' ? 'all' : offer.sku_scope.join(', ')} required /></label>
        <label>Identity tiers <input name="identity_tiers" defaultValue={offer.identity_tiers.join(', ')} required /></label>
        <label>Stacking group <input name="stacking_group" defaultValue={offer.stacking_group ?? ''} /></label>
        <label>Valid from <input name="valid_from" defaultValue={offer.valid_from} required /></label>
        <label>Valid until <input name="valid_until" defaultValue={offer.valid_until} required /></label>
        <button type="submit">Save</button>
      </form>

      <h2>Lifecycle</h2>
      {offer.status === 'draft' || offer.status === 'paused' ? (
        <form action={`/api/offers/${offer.offer_id}/publish`} method="post" style={{ display: 'grid', gap: '0.5rem', maxWidth: '24rem' }}>
          <fieldset style={{ display: 'grid', gap: '0.5rem' }}>
            <legend>Publish{offer.status === 'paused' ? ' (resume)' : ''} — bounty optional</legend>
            <label>
              Bounty type
              <select name="bounty_type">
                <option value="">No bounty (display only)</option>
                <option value="fixed">Fixed CPA (pence)</option>
                <option value="pct_of_order">Percentage of order (bps)</option>
              </select>
            </label>
            <label>Amount (pence) — fixed only <input name="bounty_amount" inputMode="numeric" pattern="\d*" /></label>
            <label>Rate (bps) — percentage only <input name="bounty_pct_bps" inputMode="numeric" pattern="\d*" /></label>
          </fieldset>
          <button type="submit">Publish</button>
        </form>
      ) : null}
      {offer.status === 'live' ? (
        <form action={`/api/offers/${offer.offer_id}/pause`} method="post"><button type="submit">Pause</button></form>
      ) : null}
      {offer.status !== 'ended' ? (
        <form action={`/api/offers/${offer.offer_id}/end`} method="post"><button type="submit">End offer</button></form>
      ) : null}

      {offer.status === 'live' && current_commitment_id ? (
        <>
          <h2>Reprice the bounty</h2>
          <p>Repricing ends the current commitment and creates a new one — history is kept, tokens in flight still verify.</p>
          <form action={`/api/offers/${offer.offer_id}/bounty`} method="post" style={{ display: 'grid', gap: '0.5rem', maxWidth: '24rem' }}>
            <label>
              Bounty type
              <select name="bounty_type" required>
                <option value="fixed">Fixed CPA (pence)</option>
                <option value="pct_of_order">Percentage of order (bps)</option>
              </select>
            </label>
            <label>Amount (pence) <input name="bounty_amount" inputMode="numeric" pattern="\d*" /></label>
            <label>Rate (bps) <input name="bounty_pct_bps" inputMode="numeric" pattern="\d*" /></label>
            <button type="submit">Reprice</button>
          </form>
        </>
      ) : null}

      <h2>Commitment history</h2>
      {corHistory.length === 0 ? <p>No commitments yet — publish with a bounty to create one.</p> : (
        <ul>
          {corHistory.map((c) => (
            <li key={c.commitment_id}>
              <code>{c.commitment_id}</code>
              {c.commitment_id === current_commitment_id ? <strong> ← current</strong> : ' (ended)'}
            </li>
          ))}
        </ul>
      )}
      {corEvents.map((row) => (
        <details key={String(row.commitment['commitment_id'])}>
          <summary>{`Commitment ${String(row.commitment['commitment_id'])} — signatures`}</summary>
          <p>merchant_sig: <code>{String(row.commitment['merchant_sig'])}</code></p>
          <p>platform_sig: <code>{String(row.commitment['platform_sig'])}</code></p>
          <pre style={{ overflowX: 'auto' }}>{JSON.stringify(row.commitment, null, 2)}</pre>
        </details>
      ))}
    </main>
  );
}
