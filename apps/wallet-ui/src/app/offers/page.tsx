import { redirect } from 'next/navigation';
import { apiGet, pounds } from '../../lib/api';
import { readOffersAsAgent } from '../../lib/agent';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Offers for you' }; // W15/#36 (SC 2.4.2)

interface Links {
  links: Array<{ programme: string; sub_hash: string; status: string }>;
}
interface Mandates {
  mandates: Array<{ mandate_id: string; status: string }>;
}

/** Screen 4 — offers for you (PH2-3): a T1-personalised quote feed fetched
 * through the platform's ORDINARY agent read API (P5: the wallet is a
 * client like any agent — registered via the open endpoint, no backdoor).
 * The consumer's link supplies the sub_hash; their live mandate rides as
 * mandate_ref, so every payable token minted here demands approval. */
export default async function Offers() {
  const me = await apiGet<{ consumer_ref: string }>('/v1/me');
  if (!me) redirect('/login');
  const links = (await apiGet<Links>('/v1/links'))?.links.filter((l) => l.status === 'active') ?? [];
  const mandate = ((await apiGet<Mandates>('/v1/mandates'))?.mandates ?? []).find(
    (m) => m.status === 'active',
  );

  const feed =
    links[0] === undefined
      ? null
      : await readOffersAsAgent({
          sub_hash: links[0].sub_hash,
          ...(mandate ? { mandate_ref: mandate.mandate_id } : {}),
        });

  return (
    <main>
      <p><a href="/">← Wallet</a></p>
      <h1>Offers for you</h1>
      {!links[0] && (
        <p>
          Link a programme first — personalised member pricing needs your consented identity
          signal. <a href="/accounts">Linked accounts →</a>
        </p>
      )}
      {feed && (
        <table cellPadding={6}>
          <thead>
            <tr>
              <th align="left">Offer</th>
              <th align="right">List</th>
              <th align="right">Your price</th>
              <th align="left">Tier</th>
              <th align="left">Payable</th>
            </tr>
          </thead>
          <tbody>
            {feed.quotes.map((q) => (
              <tr key={q.quote_id} data-tier={q.tier}>
                <td><code>{q.offer_id.slice(0, 14)}…</code></td>
                <td align="right">{pounds(q.price.list.amount)}</td>
                <td align="right">{pounds(q.price.final.amount)}</td>
                <td>{q.tier}</td>
                <td>{q.token ? (mandate ? 'yes — approval required before it converts' : 'yes') : 'display only'}</td>
              </tr>
            ))}
            {feed.quotes.length === 0 && <tr><td colSpan={5}>No live offers right now.</td></tr>}
          </tbody>
        </table>
      )}
    </main>
  );
}
