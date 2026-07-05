import { redirect } from 'next/navigation';
import { apiGet } from '../../lib/api';

export const dynamic = 'force-dynamic';

interface Links {
  links: Array<{
    link_id: string;
    programme: string;
    member_ref: string;
    scopes: string[];
    status: string;
    linked_at: string;
  }>;
}

/** Screen 2 — linked accounts (PH2-3): scopes visible, revoke button LIVE
 * (B23: revoke → T2/T3 on the next read; the CI round-trip lives in the
 * linking suite — this screen is its UI path). */
export default async function Accounts() {
  const me = await apiGet<{ consumer_ref: string }>('/v1/me');
  if (!me) redirect('/login');
  const links = (await apiGet<Links>('/v1/links'))?.links ?? [];

  return (
    <main>
      <p><a href="/">← Wallet</a></p>
      <h1>Linked accounts</h1>
      <table cellPadding={6}>
        <thead>
          <tr>
            <th align="left">Programme</th>
            <th align="left">Member</th>
            <th align="left">Scopes</th>
            <th align="left">Status</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {links.map((link) => (
            <tr key={link.link_id} data-link-status={link.status}>
              <td>{link.programme}</td>
              <td><code>{link.member_ref}</code></td>
              <td>{link.scopes.join(', ')}</td>
              <td>{link.status}</td>
              <td>
                {link.status === 'active' && (
                  <form action={`/api/links/${link.link_id}/revoke`} method="post">
                    <button type="submit">Revoke</button>
                  </form>
                )}
              </td>
            </tr>
          ))}
          {links.length === 0 && <tr><td colSpan={5}>No linked programmes.</td></tr>}
        </tbody>
      </table>
      <h2>Link a programme</h2>
      <form action="/api/links/start" method="post" style={{ display: 'grid', gap: '0.5rem', maxWidth: '22rem' }}>
        <label>Merchant id <input name="merchant_id" placeholder="mer_…" required /></label>
        <label>Programme <input name="programme" defaultValue="aurora-club" required /></label>
        <button type="submit">Link via the brand&rsquo;s sign-in</button>
      </form>

      <p style={{ maxWidth: '40rem' }}>
        Revoking a link removes the identity signal immediately: the very next offer read
        resolves you at T2/T3 and member pricing disappears — that is the consent working,
        not a bug.
      </p>
    </main>
  );
}
