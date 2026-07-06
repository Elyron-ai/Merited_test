/**
 * CSRF defence for state-changing requests (audit W6/#16). SameSite=Lax on the
 * session cookie already blocks classic cross-site POST of a cookie-bearing
 * mutation, but it does NOT stop forced-login (login/signup need no pre-existing
 * cookie) — an attacker's auto-submitting cross-site form could log an operator
 * into the attacker's tenant. An Origin / Sec-Fetch-Site check closes that.
 *
 * Policy: reject only on POSITIVE evidence of a cross-site request. A browser
 * sends `Sec-Fetch-Site` (and `Origin`) on cross-origin POSTs; server-to-server
 * and test callers send neither, so they pass. This blocks browser CSRF without
 * breaking non-browser clients. Edge-runtime safe (no Node APIs).
 */
export const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const isCrossSite = (headers: { get(name: string): string | null }): boolean => {
  const site = headers.get('sec-fetch-site');
  if (site === 'cross-site') return true; // unambiguous browser signal
  const origin = headers.get('origin');
  const host = headers.get('host');
  if (origin && host) {
    try {
      return new URL(origin).host !== host; // Origin's host must equal the target host
    } catch {
      return true; // malformed Origin → treat as hostile
    }
  }
  return false; // no cross-site evidence (non-browser client / same-origin GET-style)
};
