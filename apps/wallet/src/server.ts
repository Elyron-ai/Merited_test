import {
  ApprovalRequestCreate,
  ApprovalRequestStatus,
  HostedLinkStartRequest,
  HostedLinkVerifyRequest,
  MandateAttenuateRequest,
  MandateGrantRequest,
  PushSubscription,
  type IdentityProviderAdapter,
  type LoyaltyLookup,
  type Mailer,
} from '@merited/contracts';
import formbody from '@fastify/formbody';
import Fastify, { type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { MagicLinkAuth } from './auth/magic-link.js';
import {
  SessionStore,
  WALLET_SESSION_COOKIE,
  WALLET_HSTS_VALUE,
  serializeSessionCookie,
  walletCookieIsSecure,
} from './auth/session.js';
import { allowMagicLink } from './lib/rate-limit.js';
import { isCrossSite, UNSAFE_METHODS } from './lib/csrf.js';
import { LinkService } from './modules/linking/link-service.js';
import { HostedLinkService } from './modules/linking/hosted/hosted-link-service.js';
import { LinkTokenStore } from './modules/linking/link-token-store.js';
import { MandateService } from './modules/mandates/mandate-service.js';
import { MandateWideningError } from './modules/mandates/attenuation.js';
import {
  ApprovalsService,
  PgQuoteReader,
  type QuoteGateway,
  type ReMint,
} from './modules/notifications/approvals.js';
import { ApprovalRequestsService } from './modules/notifications/approval-requests.js';
import { PushService, WebPushTransport, type PushTransport } from './modules/notifications/push.js';
import { generateVapidKeys, type VapidConfig } from './modules/notifications/vapid.js';
import { PdStore } from './modules/pd-store/pd-store.js';
import { FakeCrypter, FakeSigner, type Crypter, type Signer } from '@merited/signing';

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
  /** PH1-13: resolve an IdP adapter for a programme (the core registry,
   * injected — the wallet depends on the contract interface only). */
  resolveIdpAdapter?(programme: string): IdentityProviderAdapter | null;
  /** Where the IdP redirects back (this wallet's /v1/links/callback). */
  linkCallbackUrl?: string;
  /** Crypter for the sealed link-token store (FakeCrypter dev; KMS prod). */
  crypter?: Crypter;
  /** PH1-14: resolve the brand loyalty API for a programme (hosted-linking
   * member-number check). The core adapter is injected — the wallet depends
   * on the contract interface only. */
  resolveLoyalty?(programme: string): LoyaltyLookup | null;
  /** PH1-16: signs mandate/approval attestations (platform attests in Ph 1).
   * FakeSigner in dev/test; the real Ed25519 signer via factory in prod. */
  signer?: Signer;
  /** PH1-17: VAPID keys (env via `vapidFromEnv` in prod; ephemeral dev keys
   * when omitted) and the push delivery seam (CapturingPushTransport in CI). */
  vapid?: VapidConfig;
  pushTransport?: PushTransport;
  /** PH1-18: quote reads (Pg over core.quotes by default) and the trio
   * re-mint call — core's TrioTokenClient injected as a function. With no
   * reMint wired, approve fails closed with REMINT_FAILED. */
  quoteGateway?: QuoteGateway;
  reMint?: ReMint;
  /** PH2-4: offer/merchant copy for approval-request push payloads. */
  quoteCopyFor?(quoteId: string): Promise<{ offer_title: string; merchant_name: string } | null>;
  /** TRIO-17: service token guarding the /internal/directory/* lookup routes
   * the trio's HttpDirectory calls. Routes exist ONLY when this is set. */
  directoryServiceToken?: string;
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
  const linkTokens = new LinkTokenStore(options.pool, options.crypter ?? new FakeCrypter('wallet-link-dev'));
  const linkService = new LinkService({
    pool: options.pool,
    tokens: linkTokens,
    resolveAdapter: options.resolveIdpAdapter ?? (() => null),
    clock,
    callbackUrl: options.linkCallbackUrl ?? `${options.verifyBaseUrl.replace(/\/verify$/, '')}/v1/links/callback`,
  });
  const hostedLinkService = new HostedLinkService({
    pool: options.pool,
    mailer: options.mailer,
    resolveLoyalty: options.resolveLoyalty ?? (() => null),
    clock,
  });
  const mandates = new MandateService({
    pool: options.pool,
    signer: options.signer ?? new FakeSigner('wallet-mandate-dev'),
    clock,
  });
  const push = new PushService({
    pool: options.pool,
    transport: options.pushTransport ?? new WebPushTransport(),
    vapid: options.vapid ?? { ...generateVapidKeys(), subject: 'mailto:dev@merited.test' },
    clock,
  });
  const approvals = new ApprovalsService({
    pool: options.pool,
    mandates,
    quotes: options.quoteGateway ?? new PgQuoteReader(options.pool),
    reMint: options.reMint ?? (() => Promise.resolve(null)), // fail closed
    clock,
    push,
  });
  const approvalRequests = new ApprovalRequestsService({
    pool: options.pool,
    mandates,
    approvals,
    quotes: options.quoteGateway ?? new PgQuoteReader(options.pool),
    clock,
    push,
    ...(options.quoteCopyFor ? { quoteCopyFor: options.quoteCopyFor } : {}),
  });

  // W7/#25: finite request + connection timeouts (Fastify defaults are 0 =
  // disabled) — a stalled slow-body connection cannot hold a socket open
  // indefinitely (slowloris).
  const app = Fastify({ requestTimeout: 30_000, connectionTimeout: 30_000 });
  void app.register(formbody);
  const PUBLIC = new Set(['/healthz', '/v1/auth/request', '/v1/auth/verify']);

  // W6: refuse provably cross-site state-changing requests (runs before the
  // session preHandler). Defence-in-depth over SameSite=Lax; covers the
  // no-cookie magic-link request too.
  app.addHook('onRequest', async (req, reply) => {
    if (UNSAFE_METHODS.has(req.method) && isCrossSite(req.headers)) {
      await reply.code(403).send({ error: { code: 'CSRF_BLOCKED' } });
    }
  });

  // W8: HSTS in production (same gate as the Secure cookie) so the 30-day
  // session cookie can never leak over an induced plain-HTTP request.
  if (walletCookieIsSecure()) {
    app.addHook('onSend', async (_req, reply, payload) => {
      void reply.header('strict-transport-security', WALLET_HSTS_VALUE);
      return payload;
    });
  }

  app.addHook('preHandler', async (req, reply) => {
    // TRIO-17: internal directory routes carry their own service-token guard
    if (req.url.startsWith('/internal/directory/')) return;
    // PH2-4: agent-facing approval requests — no consumer session (the agent
    // is not the consumer); requesting grants nothing, the mandate decides
    if (req.url.startsWith('/v1/approval-requests')) return;
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
    // W4/#23: throttle per source IP (socket peer, not a spoofable header) and
    // per target email. When over the cap we SILENTLY skip the send and still
    // return the uniform 202 — this stops email bombing without adding an
    // address-existence oracle (a 429 would signal per-email state).
    if (allowMagicLink(req.ip, email)) {
      await magicLink.request(email);
    }
    // uniform response — never reveals whether the address is known
    return reply.code(202).send({ ok: true });
  });

  app.post('/v1/auth/verify', async (req, reply) => {
    const { token } = (req.body ?? {}) as { token?: string };
    if (typeof token !== 'string') return reply.code(400).send({ error: { code: 'TOKEN_REQUIRED' } });
    const result = await magicLink.verify(token);
    if (!result) return reply.code(401).send({ error: { code: 'LINK_INVALID' } });
    const signed = await sessions.mint(result.consumerRef);
    void reply.header('set-cookie', serializeSessionCookie(signed));
    return reply.send({ ok: true });
  });

  app.post('/v1/auth/logout', async (req, reply) => {
    const cookie = readCookie(req.headers.cookie, WALLET_SESSION_COOKIE);
    if (cookie) await sessions.destroy(cookie);
    void reply.header('set-cookie', serializeSessionCookie('', { maxAge: 0 }));
    return reply.send({ ok: true });
  });

  // ── whoami + consented 1PD (session-guarded) ───────────────────────────────
  app.get('/v1/me', async (req) => ({ consumer_ref: req.consumerRef }));

  app.get('/v1/pd', async (req) => ({ items: await pdStore.list(req.consumerRef) }));

  // ── session-scoped read models (PH2-3: what the wallet UI renders) ────────
  app.get('/v1/links', async (req) => {
    const { rows } = await options.pool.query(
      `SELECT link_id, merchant_id, programme, member_ref, sub_hash, scopes, status, linked_at
         FROM wallet.identity_links WHERE consumer_ref = $1 ORDER BY linked_at`,
      [req.consumerRef],
    );
    return { links: rows };
  });

  app.get('/v1/mandates', async (req) => {
    const { rows } = await options.pool.query(
      `SELECT mandate_id, agent_id, scopes, limits, merchants, data_sharing,
              pre_authorised_up_to, status, exp
         FROM wallet.mandates WHERE consumer_ref = $1 ORDER BY mandate_id`,
      [req.consumerRef],
    );
    return { mandates: rows };
  });

  app.get('/v1/points', async (req) => {
    const { rows } = await options.pool.query(
      `SELECT programme, member_ref, points::int, quote_id, credited_at
         FROM wallet.points_credits WHERE consumer_ref = $1 ORDER BY credited_at DESC`,
      [req.consumerRef],
    );
    const balances = new Map();
    for (const row of rows) {
      balances.set(row.programme, (balances.get(row.programme) ?? 0) + row.points);
    }
    return {
      credits: rows,
      balances: [...balances.entries()].map(([programme, points]) => ({ programme, points })),
    };
  });

  /** PH2-3 screen 5 feed: the consumer's approval requests with the quote's
   * locked price and deadline (core.quotes is readable in the single-DB
   * phase — the same seam PgQuoteReader rides). */
  app.get('/v1/me/approval-requests', async (req) => {
    const { rows } = await options.pool.query(
      `SELECT ar.quote_id, ar.mandate_id, ar.status, ar.mode, ar.approval_id, ar.created_at, ar.decided_at,
              q.final_amount::int AS final_pence, q.expires_at
         FROM wallet.approval_requests ar
         LEFT JOIN core.quotes q ON q.quote_id = ar.quote_id
        WHERE ar.consumer_ref = $1 ORDER BY ar.created_at DESC LIMIT 50`,
      [req.consumerRef],
    );
    return { requests: rows };
  });

  /** PH2-3 screen 6: the consumer-visible ledger tail — what the agent did
   * (ErrandStateChanged, joined to the consumer through their approval
   * requests), what was approved at which locked price, what was credited.
   * Ledger + ledger-derived rows only (P1). */
  app.get('/v1/activity', async (req) => {
    const { rows: credits } = await options.pool.query(
      `SELECT claim_id, programme, points::int, quote_id, credited_at
         FROM wallet.points_credits WHERE consumer_ref = $1`,
      [req.consumerRef],
    );
    const { rows: approvals } = await options.pool.query(
      `SELECT a.approval_id, a.quote_id, a.mode, a.approved_at, q.final_amount::int AS final_pence
         FROM wallet.approvals a
         JOIN wallet.mandates m ON m.mandate_id = a.mandate_id
         LEFT JOIN core.quotes q ON q.quote_id = a.quote_id
        WHERE m.consumer_ref = $1`,
      [req.consumerRef],
    );
    const { rows: errands } = await options.pool.query(
      `SELECT e.body->'data'->>'errand_id' AS errand_id,
              e.body->'data'->>'to' AS state,
              e.body->'data'->>'quote_id' AS quote_id,
              e.body->'data'->>'at' AS at
         FROM events.events e
         JOIN wallet.approval_requests ar ON ar.quote_id = e.body->'data'->>'quote_id'
        WHERE e.type = 'ErrandStateChanged' AND ar.consumer_ref = $1
        ORDER BY e.seq`,
      [req.consumerRef],
    );
    return { credits, approvals, errands };
  });

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

  // ── account linking (PH1-13, B23) ──────────────────────────────────────────
  app.post('/v1/links/start', async (req, reply) => {
    const body = (req.body ?? {}) as { merchant_id?: string; programme?: string; return_url?: string };
    if (!body.merchant_id || !body.programme) {
      return reply.code(400).send({ error: { code: 'MERCHANT_AND_PROGRAMME_REQUIRED' } });
    }
    try {
      const result = await linkService.start({
        consumerRef: req.consumerRef,
        merchantId: body.merchant_id,
        programme: body.programme,
        ...(body.return_url ? { returnUrl: body.return_url } : {}),
      });
      return reply.send(result);
    } catch (error) {
      // W9/#30: never echo the internal message to the client — log it server-side.
      req.log.error({ err: error }, 'link start failed');
      return reply.code(400).send({ error: { code: 'LINK_START_FAILED' } });
    }
  });

  app.get('/v1/links/callback', async (req, reply) => {
    const q = req.query as { state?: string; code?: string; error?: string };
    if (q.error) return reply.code(400).send({ error: { code: 'LINK_DENIED', detail: q.error } });
    if (!q.state || !q.code) return reply.code(400).send({ error: { code: 'CALLBACK_PARAMS_MISSING' } });
    try {
      const link = await linkService.callback({
        state: q.state,
        code: q.code,
        sessionConsumerRef: req.consumerRef,
      });
      // never echo tokens — only the link record (which carries none)
      return reply.send({ link });
    } catch (error) {
      // W9/#30: a uniform code — the message split "not yours" vs "invalid state"
      // was a consumer-ownership oracle. Detail stays server-side only.
      req.log.error({ err: error }, 'link callback failed');
      return reply.code(401).send({ error: { code: 'LINK_CALLBACK_FAILED' } });
    }
  });

  app.post('/v1/links/:id/revoke', async (req, reply) => {
    const linkId = (req.params as { id: string }).id;
    const revoked = await linkService.revoke({ linkId, revokedBy: 'wallet', consumerRef: req.consumerRef });
    return reply.send({ revoked });
  });

  // ── hosted-linking fallback (PH1-14, B23) — IdP-less programmes ─────────────
  // The request schema has NO credential field by construction — the email is
  // the only factor (§6.3 "never credential capture"; architecture §8/Q7).
  app.post('/v1/links/hosted/start', async (req, reply) => {
    const parsed = HostedLinkStartRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'HOSTED_LINK_START_INVALID' } });
    }
    const result = await hostedLinkService.start({
      consumerRef: req.consumerRef,
      merchantId: parsed.data.merchant_id,
      programme: parsed.data.programme,
      memberRef: parsed.data.member_ref,
      email: parsed.data.email,
    });
    return reply.send(result);
  });

  app.post('/v1/links/hosted/verify', async (req, reply) => {
    const parsed = HostedLinkVerifyRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'HOSTED_LINK_VERIFY_INVALID' } });
    }
    const link = await hostedLinkService.verify({
      attemptId: parsed.data.attempt_id,
      token: parsed.data.token,
      sessionConsumerRef: req.consumerRef,
    });
    // unverified / wrong / replayed → no link (uniform failure)
    if (!link) return reply.code(401).send({ error: { code: 'HOSTED_LINK_UNVERIFIED' } });
    return reply.send({ link });
  });

  // ── consent & mandates (PH1-16, B14) ───────────────────────────────────────
  app.post('/v1/mandates', async (req, reply) => {
    const parsed = MandateGrantRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'MANDATE_GRANT_INVALID', detail: parsed.error.issues } });
    }
    try {
      const mandate = await mandates.grant({ consumerRef: req.consumerRef, request: parsed.data });
      return reply.code(201).send({ mandate });
    } catch (error) {
      // W9/#30: opaque code out; the internal reason is logged, never echoed.
      req.log.error({ err: error }, 'mandate grant failed');
      return reply.code(400).send({ error: { code: 'MANDATE_GRANT_FAILED' } });
    }
  });

  app.post('/v1/mandates/:id/attenuate', async (req, reply) => {
    const parsed = MandateAttenuateRequest.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'MANDATE_ATTENUATE_INVALID', detail: parsed.error.issues } });
    }
    try {
      const child = await mandates.attenuate({
        consumerRef: req.consumerRef,
        parentId: (req.params as { id: string }).id,
        patch: parsed.data,
      });
      return reply.code(201).send({ mandate: child });
    } catch (error) {
      // widening (or any invalid narrowing) is a 422 — the request is well-formed
      // but would escalate authority, which is forbidden by construction
      if (error instanceof MandateWideningError) {
        return reply.code(422).send({ error: { code: 'MANDATE_WOULD_WIDEN', violations: error.violations } });
      }
      // W9/#30: opaque code out; the internal reason is logged, never echoed.
      req.log.error({ err: error }, 'mandate attenuate failed');
      return reply.code(400).send({ error: { code: 'MANDATE_ATTENUATE_FAILED' } });
    }
  });

  app.post('/v1/mandates/:id/revoke', async (req, reply) => {
    const revoked = await mandates.revoke({
      mandateId: (req.params as { id: string }).id,
      consumerRef: req.consumerRef,
    });
    return reply.send({ revoked });
  });

  // ── approvals (PH1-18, B26) ────────────────────────────────────────────────
  app.post('/v1/quotes/:id/approve', async (req, reply) => {
    const body = (req.body ?? {}) as { mandate_id?: string };
    if (!body.mandate_id) return reply.code(400).send({ error: { code: 'MANDATE_ID_REQUIRED' } });
    const idempotencyKey = req.headers['idempotency-key'];
    const result = await approvals.approve({
      consumerRef: req.consumerRef,
      quoteId: (req.params as { id: string }).id,
      mandateId: body.mandate_id,
      ...(typeof idempotencyKey === 'string' ? { idempotencyKey } : {}),
    });
    await approvalRequests.recordDecision((req.params as { id: string }).id, result);
    if (result.outcome === 'approved') return reply.send(result);
    const status = result.outcome === 'QUOTE_NOT_FOUND' ? 404 : 409;
    return reply.code(status).send({ error: { code: result.outcome } });
  });

  app.post('/v1/quotes/:id/decline', async (req, reply) => {
    const body = (req.body ?? {}) as { mandate_id?: string };
    if (!body.mandate_id) return reply.code(400).send({ error: { code: 'MANDATE_ID_REQUIRED' } });
    const result = await approvals.decline({
      consumerRef: req.consumerRef,
      quoteId: (req.params as { id: string }).id,
      mandateId: body.mandate_id,
    });
    await approvalRequests.recordDecision((req.params as { id: string }).id, { outcome: 'declined' });
    return reply.send(result);
  });

  // ── approval requests (PH2-4, §6.6) — agent-facing, sessionless ───────────
  app.post('/v1/approval-requests', async (req, reply) => {
    const parsed = ApprovalRequestCreate.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'APPROVAL_REQUEST_INVALID', detail: parsed.error.issues } });
    }
    const request = await approvalRequests.create({
      quoteId: parsed.data.quote_id,
      mandateId: parsed.data.mandate_id,
    });
    if (!request) return reply.code(404).send({ error: { code: 'QUOTE_OR_MANDATE_NOT_FOUND' } });
    return reply.code(201).send({ request: ApprovalRequestStatus.parse(request) });
  });

  app.get('/v1/approval-requests/:quoteId', async (req, reply) => {
    const request = await approvalRequests.status((req.params as { quoteId: string }).quoteId);
    if (!request) return reply.code(404).send({ error: { code: 'APPROVAL_REQUEST_NOT_FOUND' } });
    return reply.send({ request: ApprovalRequestStatus.parse(request) });
  });

  // ── trio directory lookups (TRIO-17) ───────────────────────────────────────
  // Service-to-service: the trio's HttpDirectory resolves approvals/mandates
  // here at claim time and VERIFIES the attestation before trusting anything
  // (P3). Mandates are re-attested over CURRENT state so a revocation is a
  // verified fact at the trio, live, no cache window.
  if (options.directoryServiceToken) {
    const directoryToken = options.directoryServiceToken;
    const guarded = async (req: { headers: Record<string, unknown> }, reply: { code(n: number): { send(b: unknown): unknown } }): Promise<boolean> => {
      if (req.headers['x-merited-service-token'] !== directoryToken) {
        await reply.code(401).send({ error: { code: 'SERVICE_TOKEN_INVALID' } });
        return false;
      }
      return true;
    };

    app.get('/internal/directory/approvals/:id', async (req, reply) => {
      if (!(await guarded(req as never, reply as never))) return reply;
      const approval = await mandates.approvalById((req.params as { id: string }).id);
      if (!approval) return reply.code(404).send({ error: { code: 'APPROVAL_NOT_FOUND' } });
      return reply.send({ approval });
    });

    app.get('/internal/directory/mandates/:id', async (req, reply) => {
      if (!(await guarded(req as never, reply as never))) return reply;
      const mandate = await mandates.attestedCurrent((req.params as { id: string }).id);
      if (!mandate) return reply.code(404).send({ error: { code: 'MANDATE_NOT_FOUND' } });
      return reply.send({ mandate });
    });
  }

  // ── web push (PH1-17, B25) ─────────────────────────────────────────────────
  app.post('/v1/push/subscriptions', async (req, reply) => {
    const parsed = PushSubscription.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: { code: 'PUSH_SUBSCRIPTION_INVALID' } });
    }
    await push.register(req.consumerRef, parsed.data);
    return reply.code(201).send({ ok: true });
  });

  return app;
};
