import './otel-first.js';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { context, trace, type Span } from '@opentelemetry/api';
import { newId, type FakeShopOrderWebhook, type MandateGrantRequest, type NotificationPayload, type OfferQuote } from '@merited/contracts';
import { MintVsClaimMonitor, TrioTokenClient, FakeAuroraIdpAdapter, IdpRegistry, FakeAuroraLoyalty } from '@merited/core';
import { createSimulatedCore } from '@merited/core/testing';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import {
  createFakeAuroraIdp,
  createFakeAuroraLoyalty,
  deliverOrderWebhook,
  createFakeShop,
  type FakeAuroraIdp,
  type FakeAuroraLoyalty as FakeLoyaltyServer,
} from '@merited/fake-aurora';
import { Ed25519Signer, InMemoryKms } from '@merited/signing';
import { PgKeyStore } from '@merited/trio';
import {
  buildWalletServer,
  CapturingPushTransport,
  generateVapidKeys,
  MandateService,
  PushService,
  SmtpMailer,
} from '@merited/wallet';
import { FakeShopRail, PostgresCredentialsStore, QuoteClient, VerdictPoller } from '@merited/valet';
import { verifyChain } from '@merited/events';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../apps/core/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../../apps/trio/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateWallet } from '../../../apps/wallet/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateValet } from '../../../apps/valet/scripts/migrate.mjs';
import { runSeed } from '@merited/seed';
import { AURORA_MERCHANT_ID } from '@merited/seed';

/**
 * PH1-27 — full-dress FakeAurora go-live (SYN-33). Aurora Experiences on the
 * REAL trio: one shared Ed25519 signer (KMS-enveloped keys in the real
 * versioned PgKeyStore) drives real PASETO tokens, real COR signatures, real
 * consent attestations. Three programmatic flows, CI-green on a clean
 * machine:
 *
 *   (a) runWalletlessFlow — the Act-1 loop on real crypto
 *   (b) runWalletPathFlow — link → mandate → T1 quote → push → approve →
 *       re-mint(apr) → FakeShop checkout → verify (approval+limit) →
 *       Aurora Club points credit; §6.1/§6.4 negatives on real rails
 *   (c) runFailureDrills — FAKESHOP_DROP_WEBHOOK_PCT under-reporting drill
 *       (PH1-20 alert within one cycle), webhook retry/idempotency replay
 *
 * A real partner reuses THIS path — the Grade-B adapter is config-per-
 * merchant, not a fork. The cutover checklist lives beside this file.
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const SERVICE_TOKEN = 'phase1-e2e-token';
const MAILPIT_API = process.env['MERITED_MAILPIT_API'] ?? 'http://localhost:8025';
const sha256hex = (s: string): string => createHash('sha256').update(s).digest('hex');

export interface Phase1World {
  pool: pg.Pool;
  appUrl: string;
  trio: SimulatedTrio;
  trioUrl: string;
  coreUrl: string;
  walletUrl: string;
  signer: Ed25519Signer;
  quotes: QuoteClient;
  mandates: MandateService;
  push: PushService;
  pushTransport: CapturingPushTransport;
  loyaltyAdapter: FakeAuroraLoyalty;
  loyaltyServer: FakeLoyaltyServer;
  webhookSecret: string;
  merchantSlug: string;
  /** A FakeShop bound to the core adapter; dropPct per instance (drills). */
  openShop(dropPct?: number): Promise<{ rail: FakeShopRail; shopUrl: string; close(): Promise<void> }>;
  walletSession(email: string): Promise<string>;
  close(): Promise<void>;
}

const freeMailboxToken = async (email: string): Promise<string> => {
  const list = (await (
    await fetch(`${MAILPIT_API}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
  ).json()) as { messages: Array<{ ID: string }> };
  const full = (await (await fetch(`${MAILPIT_API}/api/v1/message/${list.messages[0]!.ID}`)).json()) as { Text: string };
  return new URL(full.Text.match(/https?:\/\/\S+/)![0]).searchParams.get('token')!;
};

export const createPhase1World = async (): Promise<Phase1World> => {
  const dbName = `merited_ph127_${Date.now().toString(36)}`;
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  await migrateTrio(adminUrl);
  await migrateWallet(adminUrl);
  await migrateValet(adminUrl);
  const appUrl = `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;
  const pool = new pg.Pool({ connectionString: appUrl, max: 12 });
  pool.on('error', () => {});

  // ONE real signer over the real versioned key store — trio, core (claim
  // signing), seed and wallet (attestations) all share it, exactly as the
  // platform process would (SYN-32 custody: keys sealed at rest, in-process
  // only when open).
  const signer = new Ed25519Signer(new InMemoryKms(), new PgKeyStore(pool));

  const trio = createSimulatedTrio({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signer, signerSecret: 'unused' });
  const trioUrl = await trio.listen();
  const core = createSimulatedCore({
    databaseUrl: appUrl,
    trioBaseUrl: trioUrl,
    trioServiceToken: SERVICE_TOKEN,
    signerSecret: 'unused',
    signer,
  });
  const coreUrl = await core.listen();

  // Aurora onboarded like a real merchant: record + commercial config +
  // custodied keypair through the real commitment service (the control-plane
  // UI path is MER-5's proven e2e; the seed drives the same services).
  await runSeed({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signer, log: () => {} });
  const webhookSecret = (await core.merchants.issueWebhookSecret(AURORA_MERCHANT_ID)).secret;
  const merchantSlug = (await core.merchants.get(AURORA_MERCHANT_ID)).slug;

  // FakeAurora brand estate: OIDC IdP (issuer pinned to a pre-reserved port)
  // + loyalty API
  const idpPort = await new Promise<number>((resolve) => {
    const probe = createServer();
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
  const boundIdpUrl = `http://127.0.0.1:${idpPort}`;
  const idp2: FakeAuroraIdp = await createFakeAuroraIdp({
    issuer: boundIdpUrl,
    clientId: 'merited-wallet',
    clientSecret: 'aurora-idp-secret',
  });
  await idp2.app.listen({ port: idpPort, host: '127.0.0.1' });
  const loyaltyServer = await createFakeAuroraLoyalty();
  const loyaltyUrl = await loyaltyServer.listen();
  const loyaltyAdapter = new FakeAuroraLoyalty({ baseUrl: loyaltyUrl });

  // wallet backend on the SAME signer (attestations verify at the trio)
  const pushTransport = new CapturingPushTransport();
  const vapid = { ...generateVapidKeys(), subject: 'mailto:phase1@merited.test' };
  const tokenClient = new TrioTokenClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN });
  let walletUrl = '';
  const registry = new IdpRegistry();
  const wallet: FastifyInstance = buildWalletServer({
    pool,
    mailer: new SmtpMailer({ host: 'localhost', port: 1025, from: 'noreply@merited.test' }),
    sessionSecret: 'phase1-e2e-session',
    verifyBaseUrl: 'http://placeholder.invalid/verify',
    signer,
    vapid,
    pushTransport,
    resolveIdpAdapter: (programme) => registry.resolve(programme),
    resolveLoyalty: (programme) => (programme === 'aurora-club' ? loyaltyAdapter : null),
    reMint: async (request) => {
      const minted = await tokenClient.mint(request);
      return minted.ok ? minted.minted : null;
    },
  });
  walletUrl = await wallet.listen({ port: 0, host: '127.0.0.1' });
  registry.register(
    'aurora-club',
    new FakeAuroraIdpAdapter({
      issuer: boundIdpUrl,
      clientId: 'merited-wallet',
      clientSecret: 'aurora-idp-secret',
      redirectUri: `${walletUrl}/v1/links/callback`,
    }),
  );

  const mandates = new MandateService({ pool, signer, clock: { now: () => new Date() } });
  const push = new PushService({ pool, transport: pushTransport, vapid, clock: { now: () => new Date() } });

  const shops: FastifyInstance[] = [];
  let shopSeq = 0; // distinct domain per shop instance — each FakeShop restarts
  // its order numbers at 1001, and order_ref_hash = sha256(domain:number)
  const world: Phase1World = {
    pool,
    appUrl,
    trio,
    trioUrl,
    coreUrl,
    walletUrl,
    signer,
    quotes: new QuoteClient({
      baseUrl: coreUrl,
      store: new PostgresCredentialsStore(pool),
      name: 'Valet',
      contact: 'valet@merited.test',
    }),
    mandates,
    push,
    pushTransport,
    loyaltyAdapter,
    loyaltyServer,
    webhookSecret,
    merchantSlug,
    openShop: async (dropPct = 0) => {
      const merchant = await core.merchants.get(AURORA_MERCHANT_ID);
      shopSeq += 1;
      const shop = createFakeShop({
        shopDomain: `aurora-${shopSeq}.fakeshop.test`,
        adapterUrl: `${coreUrl}/v1/merchants/${merchant.slug}/webhooks/order-confirmed`,
        webhookSecret,
        ...(dropPct > 0 ? { dropWebhookPct: dropPct, random: () => 0 } : {}),
      });
      const shopUrl = await shop.listen({ port: 0, host: '127.0.0.1' });
      shops.push(shop);
      return { rail: new FakeShopRail(shopUrl), shopUrl, close: () => shop.close() };
    },
    walletSession: async (email: string) => {
      await fetch(`${walletUrl}/v1/auth/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      const token = await freeMailboxToken(email);
      const verified = await fetch(`${walletUrl}/v1/auth/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      return verified.headers.get('set-cookie')!.split(';')[0]!;
    },
    close: async () => {
      for (const shop of shops) await shop.close();
      await wallet.close();
      await idp2.close();
      await loyaltyServer.close();
      await core.close();
      await trio.close();
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    },
  };
  return world;
};

/** Run `fn` inside ONE root span; returns [result, traceId]. */
const inOneTrace = async <T>(name: string, fn: () => Promise<T>): Promise<[T, string]> => {
  const span: Span = trace.getTracer('merited-phase1').startSpan(name);
  try {
    const result = await context.with(trace.setSpan(context.active(), span), fn);
    return [result, span.spanContext().traceId];
  } finally {
    span.end();
  }
};

// ── (a) the walletless loop on REAL crypto ──────────────────────────────────

export interface WalletlessEvidence {
  token: string;
  verdict: string;
  claimId: string;
  traceId: string;
  eventTraceId: string | null;
  chainOk: boolean;
}

export const runWalletlessFlow = async (world: Phase1World): Promise<WalletlessEvidence> => {
  await world.quotes.ensureRegistered();
  const shop = await world.openShop();
  const [outcome, traceId] = await inOneTrace('phase1-walletless', async () => {
    const read = await world.quotes.readOffers({ text: 'spa' });
    const quote = read.quotes.find((q) => q.token !== null);
    if (!quote) throw new Error('no payable quote');
    if (!quote.token!.startsWith('v4.public.') || quote.token!.startsWith('v4.public.fake.')) {
      throw new Error('token is not a REAL PASETO v4.public token');
    }
    await shop.rail.checkout({ sku: 'sku_spa_day', attribution_token: quote.token, errand_id: newId('ern') });
    const verdict = await new VerdictPoller({ client: world.quotes }).poll(quote.quote_id);
    if (verdict.type !== 'CLAIM_VERIFIED') throw new Error(`verdict ${JSON.stringify(verdict)}`);
    return { quote, claimId: verdict.claim_id };
  });
  await shop.close();

  const { rows } = await world.pool.query<{ trace_id: string | null }>(
    `SELECT trace_id FROM events.events WHERE type = 'ConversionVerified' AND body->'data'->>'claim_id' = $1`,
    [outcome.claimId],
  );
  const client = await world.pool.connect();
  let chainOk = false;
  try {
    chainOk = (await verifyChain(client)).ok;
  } finally {
    client.release();
  }
  return {
    token: outcome.quote.token!,
    verdict: 'verified',
    claimId: outcome.claimId,
    traceId,
    eventTraceId: rows[0]?.trace_id ?? null,
    chainOk,
  };
};

// ── (b) the headless wallet-path E2E ────────────────────────────────────────

export interface WalletPathEvidence {
  linkId: string;
  tier: string;
  pushPayload: NotificationPayload;
  approvalMode: string;
  remintApr: string | null;
  verdict: string;
  pointsBefore: number;
  pointsAfter: number;
  traceId: string;
  eventTraceId: string | null;
  negatives: { revokedMandate: string; executeWithoutApproval: string };
}

export const runWalletPathFlow = async (world: Phase1World): Promise<WalletPathEvidence> => {
  const cookie = await world.walletSession('cyn.phase1@example.co.uk');
  const consumerRef = ((await (await fetch(`${world.walletUrl}/v1/me`, { headers: { cookie } })).json()) as { consumer_ref: string }).consumer_ref;

  // 1 · link Aurora Club via the FakeAurora OIDC IdP (member cyn, Gold)
  const started = (await (
    await fetch(`${world.walletUrl}/v1/links/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ merchant_id: AURORA_MERCHANT_ID, programme: 'aurora-club' }),
    })
  ).json()) as { authorize_url: string };
  const authUrl = new URL(started.authorize_url);
  const consent = await fetch(`${authUrl.origin}/authorize/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({
      state: authUrl.searchParams.get('state') ?? '',
      scope: authUrl.searchParams.get('scope') ?? '',
      redirect_uri: authUrl.searchParams.get('redirect_uri') ?? '',
      code_challenge: authUrl.searchParams.get('code_challenge') ?? '',
      username: 'cyn',
      password: 'aurora',
      decision: 'approve',
    }),
  });
  const cbTarget = new URL(consent.headers.get('location')!);
  const { link } = (await (
    await fetch(`${world.walletUrl}/v1/links/callback?state=${cbTarget.searchParams.get('state')}&code=${cbTarget.searchParams.get('code')}`, { headers: { cookie } })
  ).json()) as { link: { link_id: string; sub_hash: string } };

  // 2 · grant a mandate (per_txn covers the spa day; pre-auth below it →
  // the approval is EXPLICIT, §6.4)
  const grant: MandateGrantRequest = {
    agent_id: (await world.quotes.ensureRegistered()).agent_id,
    scopes: ['offers:read', 'checkout:execute'],
    limits: { per_txn: { amount: 10000, currency: 'GBP_pence' }, per_month: { amount: 50000, currency: 'GBP_pence' }, categories: ['experiences'] },
    merchants: ['*'],
    data_sharing: { email: false, purchase_history: false, loyalty_ids: true },
    pre_authorised_up_to: { amount: 2000, currency: 'GBP_pence' },
    exp: new Date(Date.now() + 30 * 86400_000).toISOString(),
  };
  const { mandate } = (await (
    await fetch(`${world.walletUrl}/v1/mandates`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(grant),
    })
  ).json()) as { mandate: { mandate_id: string } };

  const shop = await world.openShop();
  const [outcome, traceId] = await inOneTrace('phase1-wallet-path', async () => {
    // 3 · quote resolves T1 via the link's sub_hash (walletless agent context)
    const read = await world.quotes.readOffers({ text: 'spa', sub_hash: link.sub_hash });
    const quote = read.quotes.find((q): q is OfferQuote & { token: string } => q.token !== null);
    if (!quote) throw new Error('no payable T1 quote');
    if (quote.tier !== 'T1') throw new Error(`expected T1, got ${quote.tier}`);

    // 4 · push notification with the approval deep link (captured in CI)
    await world.push.register(consumerRef, {
      endpoint: 'https://push.example/phase1',
      keys: { p256dh: 'BPhase1FakeKeyMaterialAAAAAAAAAAAAAAAAAAAAA', auth: 'AAAAAAAAAAAAAAAAAAAAAA' },
    });
    await world.push.sendQuoteNotification(consumerRef, {
      quote_id: quote.quote_id,
      offer_title: 'Full spa day — Aurora Club price',
      merchant_name: 'Aurora Experiences',
      final: quote.price.final,
      expires_at: quote.expires_at,
    });
    const pushPayload = JSON.parse(world.pushTransport.deliveries.at(-1)!.payload) as NotificationPayload;

    // 5 · approve (the deep link's action) → re-mint with apr, idempotent
    const approved = (await (
      await fetch(`${world.walletUrl}/v1/quotes/${quote.quote_id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, 'idempotency-key': `ph1-${quote.quote_id}` },
        body: JSON.stringify({ mandate_id: mandate.mandate_id }),
      })
    ).json()) as { outcome?: string; approval: { approval_id: string; mode: string }; token: string };
    if (!approved.token) throw new Error(`approve failed: ${JSON.stringify(approved)}`);

    // the trio verifies consent artefacts before trusting them (TRIO-17 seam)
    const mandateRecord = await world.mandates.get(mandate.mandate_id);
    const approvalRecord = await world.mandates.approvalFor(quote.quote_id);
    world.trio.directory.setMandate(mandateRecord!);
    world.trio.directory.setApproval(approvalRecord!);

    // 6 · checkout with the RE-MINTED token; webhook → claim → verify passes
    // approval + limit checks on real rails
    await shop.rail.checkout({ sku: 'sku_spa_day', attribution_token: approved.token, errand_id: newId('ern') });
    const verdict = await new VerdictPoller({ client: world.quotes }).poll(quote.quote_id);
    if (verdict.type !== 'CLAIM_VERIFIED') throw new Error(`wallet-path verdict ${JSON.stringify(verdict)}`);

    const minted = await world.pool.query<{ apr: string | null }>(
      `SELECT apr FROM trio.minted_tokens WHERE qid = $1 AND apr IS NOT NULL`,
      [quote.quote_id],
    );
    return { quote, pushPayload, approved, claimId: verdict.claim_id, remintApr: minted.rows[0]?.apr ?? null };
  });
  await shop.close();

  // 7 · Aurora Club points credit on the verified conversion (idempotent)
  const before = world.loyaltyServer.balanceOf('am_seed_cyn')!;
  const orderRefHash = sha256hex(`phase1-order-${outcome.claimId}`);
  await world.loyaltyAdapter.creditPoints({ member_ref: 'am_seed_cyn', points: 84, order_ref_hash: orderRefHash });
  await world.loyaltyAdapter.creditPoints({ member_ref: 'am_seed_cyn', points: 84, order_ref_hash: orderRefHash }); // replay: no double credit
  const after = world.loyaltyServer.balanceOf('am_seed_cyn')!;

  // 8 · §6.1/§6.4 negatives on REAL rails
  // mid-flow mandate revocation → the very next approve fails MANDATE_REVOKED
  await fetch(`${world.walletUrl}/v1/mandates/${mandate.mandate_id}/revoke`, { method: 'POST', headers: { cookie } });
  const read2 = await world.quotes.readOffers({ text: 'spa', sub_hash: link.sub_hash });
  const quote2 = read2.quotes.find((q) => q.token !== null)!;
  const revokedApprove = (await (
    await fetch(`${world.walletUrl}/v1/quotes/${quote2.quote_id}/approve`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ mandate_id: mandate.mandate_id }),
    })
  ).json()) as { error?: { code: string } };

  // execute-without-approval on a wallet-path claim → APPROVAL_MISSING
  const tokenClient = new TrioTokenClient({ baseUrl: world.trioUrl, serviceToken: SERVICE_TOKEN });
  const bare = await tokenClient.mint({
    cid: outcome.quote.commitment_id as `com_${string}`,
    qid: newId('qte'),
    aid: (await world.quotes.ensureRegistered()).agent_id,
    tier: 'T1',
    session_nonce: 'ph1-negative',
    quote: { expires_at: new Date(Date.now() + 300_000).toISOString(), mandate_ref: mandate.mandate_id as `mnd_${string}` },
  });
  if (!bare.ok) throw new Error('negative-case mint failed');
  const shop2 = await world.openShop();
  await shop2.rail.checkout({ sku: 'sku_spa_day', attribution_token: bare.minted.token, errand_id: newId('ern') });
  // the claim lands and is REJECTED — poll the ledger for the rejection
  let rejectionCode = '';
  for (let attempt = 0; attempt < 40 && !rejectionCode; attempt += 1) {
    const { rows } = await world.pool.query<{ reason: string }>(
      `SELECT body->'data'->>'reason_code' AS reason FROM events.events
        WHERE type = 'ConversionRejected' AND body->'data'->>'jti' = $1`,
      [bare.minted.claims.jti],
    );
    rejectionCode = rows[0]?.reason ?? '';
    if (!rejectionCode) await new Promise((resolve) => setTimeout(resolve, 150));
  }
  await shop2.close();

  const { rows: verifiedTrace } = await world.pool.query<{ trace_id: string | null }>(
    `SELECT trace_id FROM events.events WHERE type = 'ConversionVerified' AND body->'data'->>'claim_id' = $1`,
    [outcome.claimId],
  );

  return {
    linkId: link.link_id,
    tier: outcome.quote.tier,
    pushPayload: outcome.pushPayload,
    approvalMode: outcome.approved.approval.mode,
    remintApr: outcome.remintApr,
    verdict: 'verified',
    pointsBefore: before,
    pointsAfter: after,
    traceId,
    eventTraceId: verifiedTrace[0]?.trace_id ?? null,
    negatives: {
      revokedMandate: revokedApprove.error?.code ?? 'NONE',
      executeWithoutApproval: rejectionCode || 'NONE',
    },
  };
};

// ── (c) failure-mode rehearsal ──────────────────────────────────────────────

export interface DrillEvidence {
  underReporting: { status: string; alerts: number };
  webhookReplay: { deliveries: number; claims: number };
}

export const runFailureDrills = async (world: Phase1World): Promise<DrillEvidence> => {
  // FAKESHOP_DROP_WEBHOOK_PCT=100: checkouts happen, webhooks never arrive —
  // mints without claims. PH1-20's monitor must alert within ONE cycle.
  const silentShop = await world.openShop(100);
  for (let i = 0; i < 12; i += 1) {
    const read = await world.quotes.readOffers({ text: 'spa' });
    const quote = read.quotes.find((q) => q.token !== null);
    if (!quote) throw new Error('drill: no payable quote');
    await silentShop.rail.checkout({ sku: 'sku_spa_day', attribution_token: quote.token, errand_id: newId('ern') });
  }
  await silentShop.close();

  const alerts: Array<Record<string, unknown>> = [];
  const monitor = new MintVsClaimMonitor({
    pool: world.pool,
    logger: { warn: (payload) => alerts.push(payload), info: () => {} },
    options: { floorBps: 2500, windowDays: 7, minMints: 5 },
  });
  const results = await monitor.runOnce(); // ONE projection cycle
  const aurora = results.find((r) => r.merchant_id === AURORA_MERCHANT_ID);

  // webhook retry/idempotency: the SAME webhook delivered twice → one claim
  const orderNumber = Math.floor(Date.now() / 1000); // unique per run
  const read = await world.quotes.readOffers({ text: 'spa' });
  const quote = read.quotes.find((q) => q.token !== null)!;
  const payload: FakeShopOrderWebhook = {
    event: 'order.confirmed',
    shop_domain: 'aurora.fakeshop.test',
    order: {
      number: orderNumber,
      placed_at: new Date().toISOString(),
      total: { amount_minor: 8450, currency_code: 'GBP' },
      attribution: { merited_token: quote.token },
      lines: [{ sku: 'sku_spa_day', qty: 1, unit_price_minor: 8450 }],
    },
  };
  const adapterUrl = `${world.coreUrl}/v1/merchants/${world.merchantSlug}/webhooks/order-confirmed`;
  const idem = `replay-${orderNumber}`;
  const first = await deliverOrderWebhook(payload, { adapterUrl, secret: world.webhookSecret, idempotencyKey: idem });
  const second = await deliverOrderWebhook(payload, { adapterUrl, secret: world.webhookSecret, idempotencyKey: idem });
  if (!first.delivered || !second.delivered) throw new Error('replay drill: webhook delivery failed');
  // claims for this order: exactly one, despite two deliveries
  await new Promise((resolve) => setTimeout(resolve, 400));
  const orderRefHash = sha256hex(`aurora.fakeshop.test:${orderNumber}`); // the adapter's own formula
  const { rows } = await world.pool.query<{ n: string }>(
    `SELECT count(*)::int AS n FROM events.events
      WHERE type = 'ConversionClaimed' AND body->'data'->>'order_ref_hash' = $1`,
    [orderRefHash],
  );

  return {
    underReporting: { status: aurora?.status ?? 'absent', alerts: alerts.filter((a) => a['merchant_id'] === AURORA_MERCHANT_ID).length },
    webhookReplay: { deliveries: 2, claims: Number(rows[0]?.n ?? 0) },
  };
};

// ── script mode ─────────────────────────────────────────────────────────────
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  (async () => {
    const world = await createPhase1World();
    try {
      console.log('— (a) walletless on real crypto —');
      console.log(JSON.stringify(await runWalletlessFlow(world), null, 2));
      console.log('— (b) wallet path —');
      console.log(JSON.stringify(await runWalletPathFlow(world), null, 2));
      console.log('— (c) failure drills —');
      console.log(JSON.stringify(await runFailureDrills(world), null, 2));
    } finally {
      await world.close();
    }
  })().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
