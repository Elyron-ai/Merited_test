import { redirect } from 'next/navigation';
import { apiGet, pounds } from '../../lib/api';

export const dynamic = 'force-dynamic';

interface Activity {
  credits: Array<{ claim_id: string; programme: string; points: number; quote_id: string; credited_at: string }>;
  approvals: Array<{ approval_id: string; quote_id: string; mode: string; approved_at: string; final_pence: number | null }>;
  errands: Array<{ errand_id: string; state: string; quote_id: string | null; at: string }>;
}

/** Screen 6 — activity & settlement (PH2-3): the consumer-visible ledger
 * tail. What Valet did (mirrored errand transitions), the locked price the
 * consumer approved, and what was credited — ledger and ledger-derived rows
 * only (P1: the ledger IS the product, all the way to the consumer). */
export default async function ActivityScreen() {
  const me = await apiGet<{ consumer_ref: string }>('/v1/me');
  if (!me) redirect('/login');
  const activity = await apiGet<Activity>('/v1/activity');

  return (
    <main>
      <p><a href="/">← Wallet</a></p>
      <h1>Activity &amp; settlement</h1>

      <h2>What your agent did</h2>
      <table cellPadding={6}>
        <thead>
          <tr><th align="left">When</th><th align="left">Errand</th><th align="left">Step</th></tr>
        </thead>
        <tbody>
          {(activity?.errands ?? []).map((e, i) => (
            <tr key={`${e.errand_id}:${i}`} data-errand-state={e.state}>
              <td>{e.at}</td>
              <td><code>{e.errand_id.slice(0, 12)}…</code></td>
              <td>{e.state}</td>
            </tr>
          ))}
          {(activity?.errands ?? []).length === 0 && (
            <tr><td colSpan={3}>No errands yet.</td></tr>
          )}
        </tbody>
      </table>

      <h2>Approvals — the price you locked</h2>
      <table cellPadding={6}>
        <thead>
          <tr><th align="left">When</th><th align="left">Quote</th><th align="right">Locked price</th><th align="left">Mode</th></tr>
        </thead>
        <tbody>
          {(activity?.approvals ?? []).map((a) => (
            <tr key={a.approval_id} data-approval-mode={a.mode}>
              <td>{a.approved_at}</td>
              <td><code>{a.quote_id.slice(0, 14)}…</code></td>
              <td align="right">{a.final_pence === null ? '—' : pounds(a.final_pence)}</td>
              <td>{a.mode === 'pre_authorised' ? 'pre-authorised' : 'you approved'}</td>
            </tr>
          ))}
          {(activity?.approvals ?? []).length === 0 && <tr><td colSpan={4}>Nothing approved yet.</td></tr>}
        </tbody>
      </table>

      <h2>What you earned</h2>
      <table cellPadding={6}>
        <thead>
          <tr><th align="left">When</th><th align="left">Programme</th><th align="right">Points</th></tr>
        </thead>
        <tbody>
          {(activity?.credits ?? []).map((c) => (
            <tr key={c.claim_id} data-credit={c.programme}>
              <td>{c.credited_at}</td>
              <td>{c.programme}</td>
              <td align="right">{c.points}</td>
            </tr>
          ))}
          {(activity?.credits ?? []).length === 0 && <tr><td colSpan={3}>No rewards yet.</td></tr>}
        </tbody>
      </table>
    </main>
  );
}
