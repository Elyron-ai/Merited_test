import Link from 'next/link';
import { getPool } from '../../../lib/db';
import { getMerchantsService } from '../../../lib/platform';

export const dynamic = 'force-dynamic';

export default async function MerchantDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const merchant = await getMerchantsService().get(id);
  const { rows: secrets } = await getPool().query<{ secret_id: string; secret_last4: string; created_at: Date; revoked_at: Date | null }>(
    `SELECT secret_id, secret_last4, created_at, revoked_at FROM core.merchant_webhook_secrets
      WHERE merchant_id = $1 ORDER BY created_at`,
    [id],
  );
  const { rows: keys } = await getPool().query<{ signing_key_ref: string; public_key: string }>(
    `SELECT signing_key_ref, public_key FROM core.merchant_signing_keys WHERE merchant_id = $1 ORDER BY created_at`,
    [id],
  );

  return (
    <main>
      <p><Link href="/merchants">← Merchants</Link></p>
      <h1>{merchant.name}</h1>
      <p>Slug: <code>{merchant.slug}</code> · Status: {merchant.status}</p>

      <p><a href={`/merchants/${merchant.merchant_id}/rules`}>Exclusion rules →</a></p>
      <h2>Commercial configuration</h2>
      <form action={`/api/merchants/${merchant.merchant_id}`} method="post" style={{ display: 'grid', gap: '0.5rem', maxWidth: '24rem' }}>
        <label>Name <input name="name" defaultValue={merchant.name} required /></label>
        <label>Take rate (bps) <input name="take_rate_bps" inputMode="numeric" pattern="\d+" defaultValue={merchant.commercial.take_rate_bps} required /></label>
        <label>Agent commission (bps) <input name="agent_commission_bps" inputMode="numeric" pattern="\d+" defaultValue={merchant.commercial.agent_commission_bps} required /></label>
        <label>Attribution window (seconds) <input name="attribution_window_s" inputMode="numeric" pattern="\d+" defaultValue={merchant.commercial.attribution_window_s} required /></label>
        <label>Clawback window (seconds) <input name="clawback_window_s" inputMode="numeric" pattern="\d+" defaultValue={merchant.commercial.clawback_window_s} required /></label>
        <label>Per-offer budget (pence, blank = none) <input name="per_offer_default" inputMode="numeric" pattern="\d*" defaultValue={merchant.commercial.budgets.per_offer_default?.amount ?? ''} /></label>
        <button type="submit">Save changes</button>
      </form>

      <h2>Webhook secrets</h2>
      <p>The full secret is shown exactly once, at issue time. Only the last four characters are kept visible.</p>
      <table cellPadding={6}>
        <thead><tr><th align="left">Ending</th><th align="left">Issued</th><th align="left">Status</th></tr></thead>
        <tbody>
          {secrets.map((s) => (
            <tr key={s.secret_id}>
              <td><code>{`…${s.secret_last4}`}</code></td>
              <td>{s.created_at.toISOString().slice(0, 10)}</td>
              <td>{s.revoked_at ? 'revoked' : 'live'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <form action={`/api/merchants/${merchant.merchant_id}/webhook-secret`} method="post">
        <button type="submit">Issue a new webhook secret</button>
      </form>

      <h2>Custodied signing key</h2>
      {keys.length === 0 ? (
        <p>No signing key yet — request one to enable claim signing.</p>
      ) : (
        <ul>
          {keys.map((k) => (
            <li key={k.signing_key_ref}>
              <code>{k.signing_key_ref}</code> — public key <code>{`${k.public_key.slice(0, 24)}…`}</code>
            </li>
          ))}
        </ul>
      )}
      <form action={`/api/merchants/${merchant.merchant_id}/signing-key`} method="post">
        <button type="submit">Request a custodied keypair</button>
      </form>
    </main>
  );
}
