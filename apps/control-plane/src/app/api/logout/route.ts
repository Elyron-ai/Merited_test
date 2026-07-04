import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, sessionSecret, verifySessionCookie } from '../../../lib/cookie-sign';
import { getPool } from '../../../lib/db';
import { destroySession } from '../../../lib/session';

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  const cookie = request.cookies.get(SESSION_COOKIE)?.value;
  const sessionId = cookie ? await verifySessionCookie(cookie, sessionSecret()) : null;
  if (sessionId) await destroySession(getPool(), sessionId);
  const response = NextResponse.redirect(new URL('/login', request.url), 303);
  response.cookies.delete(SESSION_COOKIE);
  return response;
};
