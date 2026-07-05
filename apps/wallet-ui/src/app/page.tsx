import { redirect } from 'next/navigation';
import { apiGet, pounds } from '../lib/api';

export const dynamic = 'force-dynamic';

interface Links {
  links: Array<{ link_id: string; programme: string; member_ref: string; status: string }>;
}
interface Points {
  balances: Array<{ programme: string; points: number }>;
  credits: Array<{ programme: string; points: number; quote_id: string; credited_at: string }>;
}
interface Mandates {
  mandates: Array<{ mandate_id: string; status: string; limits: { per_txn: { amount: number } } }>;
}

/** Screen 1 — home/balances (PH2-3): linked programmes + points + merit
 * summary, rendered ONLY from wallet read models over the public API. */
export default async function Home() {
  const me = await apiGet<{ consumer_ref: string }>('/v1/me');
  if (!me) redirect('/login');
  const [links, points, mandates] = await Promise.all([
    apiGet<Links>('/v1/links'),
    apiGet<Points>('/v1/points'),
    apiGet<Mandates>('/v1/mandates'),
  ]);
  const active = (links?.links ?? []).filter((l) => l.status === 'active');
  const liveMandates = (mandates?.mandates ?? []).filter((m) => m.status === 'active');

  return (
    <main>
      <h1>Your wallet</h1>
      <p>
        Signed in as <code>{me.consumer_ref}</code> ·{' '}
        <a href="/accounts">Linked accounts</a> · <a href="/mandate">Valet mandate</a>
      </p>

      <h2>Points balances</h2>
      <table cellPadding={6}>
        <thead>
          <tr><th align="left">Programme</th><th align="right">Points</th></tr>
        </thead>
        <tbody>
          {(points?.balances ?? []).map((b) => (
            <tr key={b.programme}>
              <td>{b.programme}</td>
              <td align="right" data-balance={b.programme}>{b.points}</td>
            </tr>
          ))}
          {(points?.balances ?? []).length === 0 && (
            <tr><td colSpan={2}>No points earned yet — Valet deals credit here.</td></tr>
          )}
        </tbody>
      </table>

      <h2>Linked programmes</h2>
      <ul>
        {active.map((l) => (
          <li key={l.link_id}>
            {l.programme} — member <code>{l.member_ref}</code>
          </li>
        ))}
        {active.length === 0 && <li>Nothing linked — link a programme to unlock member pricing.</li>}
      </ul>

      <h2>Merit summary</h2>
      <p>
        {liveMandates.length} live mandate{liveMandates.length === 1 ? '' : 's'}
        {liveMandates[0] ? (
          <> (per-transaction limit {pounds(liveMandates[0].limits.per_txn.amount)})</>
        ) : null}{' '}
        · {(points?.credits ?? []).length} rewarded deal
        {(points?.credits ?? []).length === 1 ? '' : 's'}
      </p>
    </main>
  );
}
