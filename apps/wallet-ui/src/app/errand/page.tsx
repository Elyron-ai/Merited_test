import { redirect } from 'next/navigation';
import { apiGet, pounds } from '../../lib/api';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Valet errands' }; // W15/#36 (SC 2.4.2)

interface Requests {
  requests: Array<{
    quote_id: string;
    mandate_id: string;
    status: string;
    mode: string | null;
    final_pence: number | null;
    expires_at: string | null;
  }>;
}
interface Activity {
  errands: Array<{ errand_id: string; state: string; quote_id: string | null; at: string }>;
}

/** Screen 5 — the Valet errand (PH2-3): live state-machine progress from
 * the mirrored ledger trail, and the approve/decline moment when an errand
 * parks awaiting the consumer. Briefs arrive via the wallet-driven Valet
 * (the demo driver on camera); this screen is where the human decides. */
export default async function ErrandScreen() {
  const me = await apiGet<{ consumer_ref: string }>('/v1/me');
  if (!me) redirect('/login');
  const [requests, activity] = await Promise.all([
    apiGet<Requests>('/v1/me/approval-requests'),
    apiGet<Activity>('/v1/activity'),
  ]);
  const pending = (requests?.requests ?? []).filter((r) => r.status === 'pending');

  // latest state per errand, newest first
  const latest = new Map<string, { state: string; at: string }>();
  for (const step of activity?.errands ?? []) {
    latest.set(step.errand_id, { state: step.state, at: step.at });
  }

  return (
    <main>
      <p><a href="/">← Wallet</a></p>
      <h1>Valet errands</h1>

      {pending.length > 0 && (
        <>
          <h2>Waiting on you</h2>
          {pending.map((r) => (
            <p key={r.quote_id} data-pending={r.quote_id}>
              Deal locked at <strong>{r.final_pence === null ? '…' : pounds(r.final_pence)}</strong>{' '}
              — <a href={`/approve/${r.quote_id}`}>review &amp; approve →</a>
            </p>
          ))}
        </>
      )}

      <h2>Progress</h2>
      <table cellPadding={6}>
        <thead>
          <tr><th align="left">Errand</th><th align="left">State</th><th align="left">Updated</th></tr>
        </thead>
        <tbody>
          {[...latest.entries()].reverse().map(([errandId, step]) => (
            <tr key={errandId} data-errand={step.state}>
              <td><code>{errandId.slice(0, 12)}…</code></td>
              <td>{step.state}</td>
              <td>{step.at}</td>
            </tr>
          ))}
          {latest.size === 0 && <tr><td colSpan={3}>No errands yet — brief your Valet to start one.</td></tr>}
        </tbody>
      </table>

      <h2>Full trail</h2>
      <ol>
        {(activity?.errands ?? []).map((step, i) => (
          <li key={i}>
            <code>{step.errand_id.slice(0, 12)}…</code> → {step.state} <small>{step.at}</small>
          </li>
        ))}
      </ol>
    </main>
  );
}
