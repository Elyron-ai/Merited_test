export const metadata = { title: 'Sign in' }; // W15/#36 (SC 2.4.2)

export default function Login({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  return <LoginInner searchParams={searchParams} />;
}

async function LoginInner({ searchParams }: { searchParams: Promise<{ sent?: string }> }) {
  const { sent } = await searchParams;
  return (
    <main style={{ maxWidth: '24rem' }}>
      <h1>Merited Wallet</h1>
      {sent ? (
        <p>Check your inbox — the sign-in link is on its way.</p>
      ) : (
        <form action="/api/auth/request" method="post" style={{ display: 'grid', gap: '0.5rem' }}>
          <label>
            Email <input type="email" name="email" required autoComplete="email" />
          </label>
          <button type="submit">Email me a sign-in link</button>
        </form>
      )}
    </main>
  );
}
