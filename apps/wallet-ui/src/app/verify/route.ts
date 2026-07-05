import { NextResponse, type NextRequest } from 'next/server';
import { apiBase } from '../../lib/api';

/** The magic link lands here (`verifyBaseUrl` points at this route): swap
 * the single-use token for a wallet session at the API and RELAY the
 * Set-Cookie onto the redirect — same host, so the cookie serves both the
 * API and this UI. */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.nextUrl.searchParams.get('token');
  if (!token) return NextResponse.redirect(new URL('/login', request.url), 303);
  const verified = await fetch(`${apiBase()}/v1/auth/verify`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const response = NextResponse.redirect(new URL('/', request.url), 303);
  const setCookie = verified.headers.get('set-cookie');
  if (!verified.ok || !setCookie) {
    return NextResponse.redirect(new URL('/login', request.url), 303);
  }
  response.headers.set('set-cookie', setCookie);
  return response;
}
