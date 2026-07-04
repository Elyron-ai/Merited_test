import { NextResponse, type NextRequest } from 'next/server';
import { isPublicPath, SESSION_COOKIE, sessionSecret, verifySessionCookie } from './lib/cookie-sign';

/**
 * Every route is guarded (MER-7 accept: "no route renders without a valid
 * session"). The edge check verifies the cookie's HMAC; server components
 * still validate the session ROW (expiry, existence) — defence in depth.
 */
export const middleware = async (request: NextRequest): Promise<NextResponse> => {
  const { pathname } = request.nextUrl;
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
