import Link from 'next/link';
import { mechanicsVariants } from '../../lib/mechanics-form';
import { getMerchantsService, getOffersStack } from '../../lib/platform';

export const dynamic = 'force-dynamic';

export default async function Offers() {
  const [offers, merchants] = await Promise.all([
    getOffersStack().service.list(),
    getMerchantsService().list(),
  ]);
  return (
    <main>
      <p><Link href="/">← Dashboard</Link></p>
      <h1>Offers</h1>
      <table cellPadding={6}>
        <thead><tr><th align="left">Title</th><th align="left">Mechanics</th><th align="left">Status</th></tr></thead>
        <tbody>
          {offers.map((o) => (
            <tr key={o.offer_id}>
              <td><Link href={`/offers/${o.offer_id}`}>{o.title}</Link></td>
              <td>{o.mechanics.type}</td>
              <td>{o.status}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Author an offer</h2>
      <p>Pick the mechanics first — the form is generated from the contracts union, all {mechanicsVariants().length} variants.</p>
      <form action="/offers/new" method="get" style={{ display: 'grid', gap: '0.5rem', maxWidth: '24rem' }}>
        <label>
          Merchant
          <select name="merchant" required style={{ width: '100%' }}>
            {merchants.map((m) => (
              <option key={m.merchant_id} value={m.merchant_id}>{m.name}</option>
            ))}
          </select>
        </label>
        <label>
          Mechanics
          <select name="type" required style={{ width: '100%' }}>
            {mechanicsVariants().map((v) => (
              <option key={v.type} value={v.type}>{v.type}</option>
            ))}
          </select>
        </label>
        <button type="submit">Continue</button>
      </form>
    </main>
  );
}
