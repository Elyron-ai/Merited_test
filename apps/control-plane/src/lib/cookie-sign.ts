/**
 * Session-cookie signing (MER-7). Web Crypto ONLY — this module runs in the
 * Edge middleware AND in Node route handlers. The cookie carries
 * `<sessionId>.<hmacHex>`; the middleware rejects bad signatures before any
 * page code runs, and the server side still validates the session row.
 */

import { secretFromEnv } from './require-secret';

export const SESSION_COOKIE = 'merited_cp_session';

const keyFor = async (secret: string): Promise<CryptoKey> =>
  crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

export const signSessionId = async (sessionId: string, secret: string): Promise<string> => {
  const mac = await crypto.subtle.sign('HMAC', await keyFor(secret), new TextEncoder().encode(sessionId));
  return `${sessionId}.${hex(mac)}`;
};

/** Returns the session id when the signature verifies, otherwise null. */
export const verifySessionCookie = async (value: string, secret: string): Promise<string | null> => {
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const sessionId = value.slice(0, dot);
  const expected = await signSessionId(sessionId, secret);
  // constant-time-ish compare via HMAC re-computation equality
  if (expected.length !== value.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ value.charCodeAt(i);
  return diff === 0 ? sessionId : null;
};

export const sessionSecret = (): string =>
  secretFromEnv('CONTROL_PLANE_SESSION_SECRET', 'control-plane-dev-secret');

/** Paths reachable without a session (everything else is guarded).
 * `/signup` is PH3-6's public self-serve onboarding — permitted from
 * Phase 3 (§11 excluded it only before then); the operator dashboard
 * stays fully session-gated. */
export const isPublicPath = (pathname: string): boolean =>
  pathname === '/login' ||
  pathname === '/api/login' ||
  pathname === '/signup' ||
  pathname === '/api/signup' ||
  pathname === '/favicon.ico' ||
  pathname.startsWith('/_next/');
