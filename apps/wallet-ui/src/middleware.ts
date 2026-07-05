import { NextResponse, type NextRequest } from 'next/server';

const PUBLIC = new Set(['/login', '/verify', '/api/auth/request']);

/** Cookie-presence gate; real session validation happens on every wallet
 * API call the pages make (401 → the page redirects to /login itself). */
export const middleware = (request: NextRequest): NextResponse => {
  const { pathname } = request.nextUrl;
  if (PUBLIC.has(pathname)) return NextResponse.next();
  if (!request.cookies.get('merited_wallet_session')?.value) {
    const login = request.nextUrl.clone();
    login.pathname = '/login';
    login.search = '';
    return NextResponse.redirect(login);
  }
  return NextResponse.next();
};

export const config = { matcher: ['/((?!_next/static|_next/image).*)'] };
