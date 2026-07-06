export const dynamic = 'force-dynamic';

export default async function Login({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  // W13/#7 (SC 3.3.1 / 4.1.3): the login route redirects to ?failed=1 on a bad
  // sign-in; surface it in a role="alert" region (announced to screen readers)
  // instead of silently discarding it. Credentials are never echoed back — the
  // refusal stays uniform, no email/field is preserved in the URL.
  const failed = (await searchParams).failed === '1';
  return (
    <main>
      <h1>Sign in to Merited</h1>
      <p>Internal tool — credentials and a one-time code are required.</p>
      {failed && (
        <p
          role="alert"
          style={{
            color: '#b91c1c',
            background: '#fef2f2',
            border: '1px solid #f0a3a3',
            borderRadius: '0.3rem',
            padding: '0.5rem 0.75rem',
            maxWidth: '20rem',
          }}
        >
          <strong>Sign-in failed.</strong> Check your email, password and one-time code, then try again.
        </p>
      )}
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
