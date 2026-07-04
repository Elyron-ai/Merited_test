import Link from 'next/link';
import { getMerchantsService } from '../../lib/platform';

export const dynamic = 'force-dynamic';

export default async function Merchants() {
  const merchants = await getMerchantsService().list();
  return (
    <main>
      <p><Link href="/">← Dashboard</Link></p>
      <h1>Merchants</h1>
      <table cellPadding={6} style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr><th align="left">Name</th><th align="left">Slug</th><th align="left">Status</th></tr>
        </thead>
        <tbody>
          {merchants.map((m) => (
            <tr key={m.merchant_id}>
              <td><Link href={`/merchants/${m.merchant_id}`}>{m.name}</Link></td>
              <td>{m.slug}</td>
              <td>{m.status}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2>Onboard a merchant</h2>
      <p>All money is integer pence; all rates are integer basis points.</p>
      <form action="/api/merchants" method="post" style={{ display: 'grid', gap: '0.5rem', maxWidth: '24rem' }}>
        <label>Name <input name="name" required style={{ width: '100%' }} /></label>
        <label>Take rate (bps) <input name="take_rate_bps" inputMode="numeric" pattern="\d+" defaultValue="2000" required /></label>
        <label>Agent commission (bps) <input name="agent_commission_bps" inputMode="numeric" pattern="\d+" defaultValue="6000" required /></label>
        <label>Attribution window (seconds) <input name="attribution_window_s" inputMode="numeric" pattern="\d+" defaultValue="86400" required /></label>
        <label>Clawback window (seconds) <input name="clawback_window_s" inputMode="numeric" pattern="\d+" defaultValue="2592000" required /></label>
        <label>Per-offer budget (pence, blank = none) <input name="per_offer_default" inputMode="numeric" pattern="\d*" /></label>
        <button type="submit">Create merchant</button>
      </form>
    </main>
  );
}
