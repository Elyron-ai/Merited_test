import { NextResponse, type NextRequest } from 'next/server';
import { authenticate } from '../../../lib/auth';
import { SESSION_COOKIE, sessionSecret, signSessionId } from '../../../lib/cookie-sign';
import { getPool } from '../../../lib/db';
import { allowLogin, clientIp } from '../../../lib/rate-limit';
import { createSession } from '../../../lib/session';

export const POST = async (request: NextRequest): Promise<NextResponse> => {
  const form = await request.formData();
  const email = String(form.get('email') ?? '');
  const password = String(form.get('password') ?? '');
  const totp = String(form.get('totp') ?? '');

  // §8 / audit W4: throttle BEFORE the memory-hard argon2id verify — per-IP
  // (flood) and per-email (credential/TOTP brute force). A denied attempt
  // never reaches authenticate(), so it costs no argon2 work.
  const verdict = await allowLogin(clientIp(request.headers), email);
  if (!verdict.allowed) {
    return NextResponse.json(
      { error: { code: 'RATE_LIMITED' } },
      { status: 429, headers: { 'retry-after': String(verdict.retryAfterS) } },
    );
  }

  const pool = getPool();
  const user = await authenticate(pool, { email, password, totp });
  if (!user) {
    // uniform refusal: no hint whether the email, password or code failed
    return NextResponse.redirect(new URL('/login?failed=1', request.url), 303);
  }

  // a FRESH session id on every login — a presented cookie is never adopted
  const sessionId = await createSession(pool, user.user_id);
  const response = NextResponse.redirect(new URL('/', request.url), 303);
  response.cookies.set(SESSION_COOKIE, await signSessionId(sessionId, sessionSecret()), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: process.env.NODE_ENV === 'production' && process.env['MERITED_ENV'] !== 'dev',
  });
  return response;
};
