import type { NextResponse } from 'next/server';

/**
 * W8/#15/#19: HTTP Strict-Transport-Security, paired with the env-gated
 * `Secure` session cookie. Emitting HSTS forces a conforming browser to reach
 * the operator surface over HTTPS on every subsequent visit, closing the
 * induced-plain-HTTP downgrade that would otherwise leak the session cookie.
 *
 * Enforced only in production (a browser ignores HSTS received over plain HTTP,
 * so dev/test is unaffected either way, but gating keeps the header off local
 * runs). This is defence-in-depth at the app tier; the TLS-terminating edge is
 * the primary place HSTS is set — see docs/launch-readiness.md. `preload` is
 * deliberately omitted: enrolling in the browser preload list is a hard-to-
 * reverse commitment that belongs to a deploy decision, not app code.
 */
export const HSTS_VALUE = 'max-age=31536000; includeSubDomains';

export const hstsEnabled = (): boolean =>
  process.env.NODE_ENV === 'production' && process.env['MERITED_ENV'] !== 'dev';

/** Set the HSTS header on a response when in production; returns it for chaining. */
export const applyHsts = (response: NextResponse): NextResponse => {
  if (hstsEnabled()) response.headers.set('Strict-Transport-Security', HSTS_VALUE);
  return response;
};
