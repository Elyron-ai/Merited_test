export const dynamic = 'force-dynamic';

export default function Login({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  void searchParams;
  return (
    <main>
      <h1>Sign in to Merited</h1>
      <p>Internal tool — credentials and a one-time code are required.</p>
      <form action="/api/login" method="post" style={{ display: 'grid', gap: '0.75rem', maxWidth: '20rem' }}>
        <label>
          Email
          <input name="email" type="email" autoComplete="username" required style={{ width: '100%' }} />
        </label>
        <label>
          Password
          <input name="password" type="password" autoComplete="current-password" required style={{ width: '100%' }} />
        </label>
        <label>
          One-time code
          <input name="totp" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" required style={{ width: '100%' }} />
        </label>
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
