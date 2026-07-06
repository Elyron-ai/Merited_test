import { NextResponse, type NextRequest } from 'next/server';
import { isPublicPath, SESSION_COOKIE, sessionSecret, verifySessionCookie } from './lib/cookie-sign';
import { isCrossSite, UNSAFE_METHODS } from './lib/csrf';

/**
 * Every route is guarded (MER-7 accept: "no route renders without a valid
 * session"). The edge check verifies the cookie's HMAC; server components
 * still validate the session ROW (expiry, existence) — defence in depth.
 * State-changing requests additionally get a CSRF (Origin/Sec-Fetch-Site)
 * check — including the PUBLIC login/signup POSTs, so forced-login is blocked.
 */
export const middleware = async (request: NextRequest): Promise<NextResponse> => {
  const { pathname } = request.nextUrl;

  // CSRF: refuse provably cross-site state-changing requests (runs before the
  // public-path carve-out so /api/login and /api/signup are covered too).
  if (UNSAFE_METHODS.has(request.method) && isCrossSite(request.headers)) {
    return new NextResponse(JSON.stringify({ error: { code: 'CSRF_BLOCKED' } }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  if (isPublicPath(pathname)) return NextResponse.next();

  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  const sessionId = cookie ? await verifySessionCookie(cookie, sessionSecret()) : null;
  if (!sessionId) {
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.search = '';
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
};

export const config = {
  matcher: ['/((?!_next/static|_next/image).*)'],
};
