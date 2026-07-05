import { type Mailer } from '@merited/contracts';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { MagicLinkAuth } from './auth/magic-link.js';
import { SessionStore, WALLET_SESSION_COOKIE } from './auth/session.js';
import { PdStore } from './modules/pd-store/pd-store.js';

declare module 'fastify' {
  interface FastifyRequest {
    consumerRef: string;
  }
}

export interface WalletServerOptions {
  pool: pg.Pool;
  mailer: Mailer;
  clock?: { now(): Date };
  sessionSecret: string;
  verifyBaseUrl: string;
}

const readCookie = (header: string | undefined, name: string): string | undefined =>
  header
    ?.split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${name}=`))
    ?.slice(name.length + 1);

/**
 * Wallet backend (PH1-9, B15). Fastify API only (UI is Phase 2). Two public
 * routes — request a magic link, verify one — establish a session; EVERY
 * other route requires a valid session cookie (§8 hygiene: authn on every
 * route), enforced by one preHandler.
 */
export const buildWalletServer = (options: WalletServerOptions): FastifyInstance => {
  const clock = options.clock ?? { now: () => new Date() };
  const magicLink = new MagicLinkAuth({
    pool: options.pool,
    mailer: options.mailer,
    clock,
    verifyBaseUrl: options.verifyBaseUrl,
  });
  const sessions = new SessionStore({ pool: options.pool, clock, secret: options.sessionSecret });
  const pdStore = new PdStore(options.pool);

  const app = Fastify();
  const PUBLIC = new Set(['/healthz', '/v1/auth/request', '/v1/auth/verify']);

  app.addHook('preHandler', async (req, reply) => {
    if (PUBLIC.has(req.url.split('?')[0]!)) return;
    const cookie = readCookie(req.headers.cookie, WALLET_SESSION_COOKIE);
    const consumerRef = cookie ? await sessions.validate(cookie) : null;
    if (!consumerRef) {
      await reply.code(401).send({ error: { code: 'WALLET_AUTH_REQUIRED' } });
      return;
    }
    req.consumerRef = consumerRef;
  });

  app.get('/healthz', async () => ({ ok: true, service: 'wallet' }));

  // ── magic-link auth ──────────────────────────────────────────────────────
  app.post('/v1/auth/request', async (req, reply) => {
    const { email } = (req.body ?? {}) as { email?: string };
    if (typeof email !== 'string' || !email.includes('@')) {
      return reply.code(400).send({ error: { code: 'EMAIL_REQUIRED' } });
    }
    await magicLink.request(email);
    // uniform response — never reveals whether the address is known
    return reply.code(202).send({ ok: true });
  });

  app.post('/v1/auth/verify', async (req, reply) => {
    const { token } = (req.body ?? {}) as { token?: string };
    if (typeof token !== 'string') return reply.code(400).send({ error: { code: 'TOKEN_REQUIRED' } });
    const result = await magicLink.verify(token);
    if (!result) return reply.code(401).send({ error: { code: 'LINK_INVALID' } });
    const signed = await sessions.mint(result.consumerRef);
    void reply.header(
      'set-cookie',
      `${WALLET_SESSION_COOKIE}=${signed}; HttpOnly; SameSite=Lax; Path=/`,
    );
    return reply.send({ ok: true });
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const cookie = readCookie(req.headers.cookie, WALLET_SESSION_COOKIE);
    if (cookie) await sessions.destroy(cookie);
    void reply.header('set-cookie', `${WALLET_SESSION_COOKIE}=; HttpOnly; Path=/; Max-Age=0`);
    return reply.send({ ok: true });
  });

  // ── whoami + consented 1PD (session-guarded) ───────────────────────────────
  app.get('/v1/me', async (req) => ({ consumer_ref: req.consumerRef }));

  app.get('/v1/pd', async (req) => ({ items: await pdStore.list(req.consumerRef) }));

  app.put('/v1/pd/:key', async (req, reply) => {
    const key = (req.params as { key: string }).key;
    const body = (req.body ?? {}) as { value?: unknown; consented?: boolean };
    if (body.value === undefined) return reply.code(400).send({ error: { code: 'VALUE_REQUIRED' } });
    await pdStore.put(req.consumerRef, key, body.value, body.consented === true);
    return reply.send({ ok: true });
  });

  app.delete('/v1/pd/:key', async (req) => ({
    removed: await pdStore.remove(req.consumerRef, (req.params as { key: string }).key),
  }));

  return app;
};
