/**
 * CSRF defence for the wallet's state-changing requests (audit W6). The
 * session cookie is SameSite=Lax (already blocks classic cross-site POST of a
 * cookie-bearing mutation); this Origin / Sec-Fetch-Site check is
 * defence-in-depth and additionally covers the no-cookie magic-link request.
 * Reject only on positive cross-site evidence — server-to-server callers (the
 * valet, the wallet-ui proxy, tests) send neither header and pass.
 */
export const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

export const isCrossSite = (headers: Record<string, string | string[] | undefined>): boolean => {
  const site = first(headers['sec-fetch-site']);
  if (site === 'cross-site') return true;
  const origin = first(headers['origin']);
  const host = first(headers['host']);
  if (origin && host) {
    try {
      return new URL(origin).host !== host;
    } catch {
      return true; // malformed Origin → hostile
    }
  }
  return false;
};
