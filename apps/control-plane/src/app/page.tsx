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
        <li>Merchants — arrives with MER-8</li>
        <li>Offers — arrives with MER-9</li>
        <li>Claims — arrives with MER-10</li>
      </ul>
      <form action="/api/logout" method="post">
        <button type="submit">Sign out</button>
      </form>
    </main>
  );
}
