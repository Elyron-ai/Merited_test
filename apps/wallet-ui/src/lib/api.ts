import { cookies } from 'next/headers';

/**
 * The wallet UI is a pure HTTP CLIENT of the wallet API (PH2-3) — every
 * read and every action crosses the same public surface the tests and the
 * demo drive, so the UI can never grow a private backdoor. The consumer's
 * session cookie is forwarded verbatim; a 401 bubbles as null and the
 * caller redirects to /login.
 */
export const apiBase = (): string =>
  process.env['MERITED_WALLET_API_URL'] ?? 'http://127.0.0.1:3200';

export const WALLET_COOKIE = 'merited_wallet_session';

const cookieHeader = async (): Promise<string> => {
  const jar = await cookies();
  const session = jar.get(WALLET_COOKIE)?.value;
  return session ? `${WALLET_COOKIE}=${session}` : '';
};

export const apiGet = async <T>(path: string): Promise<T | null> => {
  const response = await fetch(`${apiBase()}${path}`, {
    headers: { cookie: await cookieHeader() },
    cache: 'no-store',
  });
  if (!response.ok) return null;
  return (await response.json()) as T;
};

/** Money helper: integer pence → UK pounds. Never floats. */
export const pounds = (pence: number): string => {
  const sign = pence < 0 ? '−' : '';
  const abs = Math.abs(pence);
  return `${sign}£${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};
