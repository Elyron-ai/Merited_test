import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE, sessionSecret, verifySessionCookie } from '../lib/cookie-sign';
import { getPool } from '../lib/db';
import { validateSession } from '../lib/session';

export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  const sessionId = cookie ? await verifySessionCookie(cookie, sessionSecret()) : null;
  const session = sessionId ? await validateSession(getPool(), sessionId) : null;
  if (!session) redirect('/login');

  return (
    <main>
      <h1>Merited control plane</h1>
      <p>Signed in as {session.email}.</p>
      <ul>
        <li><a href="/merchants">Merchants</a></li>
        <li><a href="/offers">Offers</a></li>
        <li><a href="/claims">Claims</a></li>
        <li><a href="/dashboard">Platform dashboard</a></li>
      </ul>
      <form action="/api/logout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
