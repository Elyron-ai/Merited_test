import { redirect } from 'next/navigation';
import { apiGet, pounds } from '../../lib/api';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Valet mandate' }; // W15/#36 (SC 2.4.2)

interface Mandates {
  mandates: Array<{
    mandate_id: string;
    agent_id: string;
    scopes: string[];
    limits: { per_txn: { amount: number }; per_month: { amount: number }; categories: string[] };
    pre_authorised_up_to: { amount: number };
    status: string;
    exp: string;
  }>;
}

/** Screen 3 — the Valet mandate (PH2-3): grant/revoke with per-txn and
 * per-month limits, category scopes and the pre-authorisation threshold.
 * Widening is impossible by construction (§6.1 — the attenuation property
 * suite); this screen is that machinery's UI path. */
export default async function MandateScreen() {
  const me = await apiGet<{ consumer_ref: string }>('/v1/me');
  if (!me) redirect('/login');
  const mandates = (await apiGet<Mandates>('/v1/mandates'))?.mandates ?? [];

  return (
    <main>
      <p><a href="/">← Wallet</a></p>
      <h1>Valet mandate</h1>

      <table cellPadding={6}>
        <thead>
          <tr>
            <th align="left">Mandate</th>
            <th align="left">Agent</th>
            <th align="right">Per txn</th>
            <th align="right">Per month</th>
            <th align="right">Pre-authorised up to</th>
            <th align="left">Categories</th>
            <th align="left">Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {mandates.map((m) => (
            <tr key={m.mandate_id} data-mandate-status={m.status}>
              <td><code>{m.mandate_id.slice(0, 12)}…</code></td>
              <td><code>{m.agent_id.slice(0, 12)}…</code></td>
              <td align="right">{pounds(m.limits.per_txn.amount)}</td>
              <td align="right">{pounds(m.limits.per_month.amount)}</td>
              <td align="right">{pounds(m.pre_authorised_up_to.amount)}</td>
              <td>{m.limits.categories.join(', ') || 'any'}</td>
              <td>{m.status}</td>
              <td>
                {m.status === 'active' && (
                  <form action={`/api/mandates/${m.mandate_id}/revoke`} method="post">
                    <button type="submit">Revoke</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
          {mandates.length === 0 && <tr><td colSpan={8}>No mandate granted yet.</td></tr>}
        </tbody>
      </table>

      <h2>Grant a mandate</h2>
      <form action="/api/mandates" method="post" style={{ display: 'grid', gap: '0.5rem', maxWidth: '26rem' }}>
        <label>Agent id <input name="agent_id" placeholder="agt_…" required /></label>
        <label>Per-transaction limit (whole £) <input name="per_txn_pounds" type="number" min="1" step="1" defaultValue="100" required /></label>
        <label>Per-month limit (whole £) <input name="per_month_pounds" type="number" min="1" step="1" defaultValue="500" required /></label>
        <label>Pre-authorised up to (whole £) <input name="pre_auth_pounds" type="number" min="0" step="1" defaultValue="20" required /></label>
        <label>Categories (comma-separated) <input name="categories" defaultValue="experiences" /></label>
        <label>Expires in (days) <input name="exp_days" type="number" min="1" step="1" defaultValue="30" required /></label>
        <button type="submit">Grant mandate</button>
      </form>
      <p style={{ maxWidth: '40rem' }}>
        Limits are integer pounds by design — money is integer pence underneath, never floats.
        A granted mandate can only ever be narrowed; widening requires granting a new one.
      </p>
    </main>
  );
}
