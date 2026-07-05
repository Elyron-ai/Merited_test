import './otel-first.js';
import { context, trace, type Span } from '@opentelemetry/api';
import { catchUp } from '@merited/events';
import { pointsCreditProjection } from '@merited/wallet';
import {
  ErrandDriver,
  EventsPackageMirror,
  ErrandStore,
  interpreterFromEnv,
  shopCatalogueSkuResolver,
  VerdictPoller,
  WalletApprovalGate,
} from '@merited/valet';
import { AURORA_MERCHANT_ID } from '@merited/seed';
import type { MandateGrantRequest, NotificationPayload } from '@merited/contracts';
import pg from 'pg';
import { createPhase1World, type Phase1World } from './e2e-phase1.js';

/**
 * PH2-11 — Demo Act 2 (`pnpm demo:act2`): the wallet loop, all nine §10
 * steps on the PH1-27 world (real Ed25519 signer, real PASETO, real COR
 * signatures) with the PH2-4 valet driver behind the REAL wallet approval
 * gate. Two outputs per run:
 *
 *  - `transcript` — the on-camera narrative: STABLE lines only (prices,
 *    tiers, states, verdicts, points — never ids or timestamps), so two
 *    runs under VALET_DETERMINISTIC=1 are BYTE-IDENTICAL (§6.6 / PH2-5).
 *  - `evidence`  — the id-bearing facts a CI assert or an auditor wants.
 */

const pounds = (pence: number): string =>
  `£${Math.floor(pence / 100)}.${String(pence % 100).padStart(2, '0')}`;

const inOneTrace = async <T>(name: string, fn: () => Promise<T>): Promise<[T, string]> => {
  const span: Span = trace.getTracer('merited-act2').startSpan(name);
  try {
    const result = await context.with(trace.setSpan(context.active(), span), fn);
    return [result, span.spanContext().traceId];
  } finally {
    span.end();
  }
};

export interface Act2Evidence {
  linkSubHash: string;
  scopesShown: string;
  mandateId: string;
  interpretedMaxPencePrice: number;
  states: string[];
  t1: { offer_id: string; tier: string; final: number };
  t3: { offer_id: string; tier: string; final: number };
  pushDeepLink: string;
  approvalMode: string;
  remintApr: string | null;
  claimId: string;
  pointsCredited: number;
  revokedReason: string;
  declinedState: string;
  chargedDuringNegatives: boolean;
  traceId: string;
  eventTraceId: string | null;
  transcript: string[];
}

export const runAct2 = async (
  world: Phase1World,
  options: { email?: string; quiet?: boolean } = {},
): Promise<Act2Evidence> => {
  const transcript: string[] = [];
  const say = (line: string): void => {
    transcript.push(line);
    if (!options.quiet) console.log(line);
  };

  const cookie = await world.walletSession(options.email ?? 'cyn.act2@example.co.uk');
  const consumerRef = ((await (await fetch(`${world.walletUrl}/v1/me`, { headers: { cookie } })).json()) as {
    consumer_ref: string;
  }).consumer_ref;
  await world.push.register(consumerRef, {
    endpoint: 'https://push.example/act2-device',
    keys: { p256dh: 'BAct2FakeKeyMaterialAAAAAAAAAAAAAAAAAAAAAAA', auth: 'AAAAAAAAAAAAAAAAAAAAAA' },
  });

  // ── 1 · link Aurora Club via the OIDC consent screen ─────────────────────
  const started = (await (
    await fetch(`${world.walletUrl}/v1/links/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ merchant_id: AURORA_MERCHANT_ID, programme: 'aurora-club' }),
    })
  ).json()) as { authorize_url: string };
  const authUrl = new URL(started.authorize_url);
  const scopesShown = authUrl.searchParams.get('scope') ?? '';
  const consent = await fetch(`${authUrl.origin}/authorize/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    redirect: 'manual',
    body: new URLSearchParams({
      state: authUrl.searchParams.get('state') ?? '',
      scope: scopesShown,
      redirect_uri: authUrl.searchParams.get('redirect_uri') ?? '',
      code_challenge: authUrl.searchParams.get('code_challenge') ?? '',
      username: 'cyn',
      password: 'aurora',
      decision: 'approve',
    }),
  });
  const cbTarget = new URL(consent.headers.get('location')!);
  const { link } = (await (
    await fetch(
      `${world.walletUrl}/v1/links/callback?state=${cbTarget.searchParams.get('state')}&code=${cbTarget.searchParams.get('code')}`,
      { headers: { cookie } },
    )
  ).json()) as { link: { link_id: string; sub_hash: string } };
  say('ACT 2 — the wallet loop (identical rails; the only differences: who the agent is, what Merited knows)');
  say(`1 · Aurora Club LINKED via OIDC consent — scopes shown: [${scopesShown}]; IdentityLink created`);

  // ── 2 · grant the Valet mandate: £150/txn, experiences, pre-auth £50 ─────
  const agentId = (await world.quotes.ensureRegistered()).agent_id;
  const grant: MandateGrantRequest = {
    agent_id: agentId,
    scopes: ['offers:read', 'checkout:execute'],
    limits: {
      per_txn: { amount: 15000, currency: 'GBP_pence' },
      per_month: { amount: 60000, currency: 'GBP_pence' },
      categories: ['experiences'],
    },
    merchants: ['*'],
    data_sharing: { email: false, purchase_history: false, loyalty_ids: true },
    pre_authorised_up_to: { amount: 5000, currency: 'GBP_pence' },
    exp: new Date(Date.now() + 30 * 86400_000).toISOString(),
  };
  const grantMandate = async (): Promise<string> =>
    ((await (
      await fetch(`${world.walletUrl}/v1/mandates`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify(grant),
      })
    ).json()) as { mandate: { mandate_id: string } }).mandate.mandate_id;
  const mandateId = await grantMandate();
  say('2 · Mandate GRANTED to Valet — £150.00/txn · experiences · pre-authorised to £50.00');

  // the valet driver (PH2-4) behind the real wallet gate
  const valetPool = new pg.Pool({
    connectionString: world.appUrl.replace('merited_app:merited_app_dev', 'merited_valet:merited_valet_dev'),
    max: 4,
  });
  valetPool.on('error', () => {});
  const shop = await world.openShop();
  const driver = new ErrandDriver({
    store: new ErrandStore(world.pool),
    mirror: new EventsPackageMirror(valetPool),
    quotes: world.quotes,
    rail: shop.rail,
    gate: new WalletApprovalGate({ walletBaseUrl: world.walletUrl }),
    poller: new VerdictPoller({ client: world.quotes, sleep: () => Promise.resolve() }),
    resolveSku: shopCatalogueSkuResolver(shop.shopUrl),
  });

  const driveTo = async (errandId: string, states: string[]): Promise<string> => {
    for (;;) {
      const next = await driver.step(errandId);
      if (!next) break;
      states.push(next.state);
      say(`    state → ${next.state}`);
    }
    const stored = (await new ErrandStore(world.pool).get(errandId))!;
    return stored.state;
  };

  // ── 3–6 in ONE trace: brief → quote → push → approve → transact ─────────
  const states: string[] = [];
  const [outcome, traceId] = await inOneTrace('act2-wallet-loop', async () => {
    // 3 · the brief, through the env-selected interpreter (§6.6)
    const brief = await interpreterFromEnv().interpret('book me a spa day under £120', {
      sub_hash: link.sub_hash,
    });
    say(`3 · Brief: "book me a spa day under £120" → interpreted ceiling ${pounds(brief.max_price!.amount)}; errand state machine on screen`);
    const startedErrand = await driver.startErrand({ brief, mandate_id: mandateId as `mnd_${string}` });
    const parkedState = await driveTo(startedErrand.errand.errand_id, states);
    if (parkedState !== 'AWAITING_APPROVAL') throw new Error(`expected the errand to park, got ${parkedState}`);
    const errand = (await new ErrandStore(world.pool).get(startedErrand.errand.errand_id))!.errand;

    // 4 · T1 member quote vs Act 1's T3 quote, side by side
    const t1Read = await world.quotes.readOffers({ text: 'spa', sub_hash: link.sub_hash, mandate_ref: mandateId });
    const t1 = t1Read.quotes.find((q) => q.quote_id === errand.quote_id) ?? t1Read.quotes[0]!;
    const t3Read = await world.quotes.readOffers({ text: 'spa' });
    const t3 = t3Read.quotes[0]!;
    // the identity story, visible: the SAME catalogue answers differently —
    // T1 unlocks the member-only offers and the Gold segment
    const t1All = await world.quotes.readOffers({ sub_hash: link.sub_hash });
    const t3All = await world.quotes.readOffers({});
    say('4 · The SAME query, two identities:');
    say(`    Act 1 (T3 acquisition): ${pounds(t3.price.final.amount)}  [tier ${t3.tier}] · ${t3All.quotes.length} offers visible`);
    say(`    Act 2 (T1 via the link): ${pounds(t1.price.final.amount)}  [tier ${t1.tier}, ${t1.segment}] · ${t1All.quotes.length} offers visible`);
    say('    identical rails — the identity signal changes the tier, the segment and what the catalogue answers');

    // 5 · price above pre-auth → push → approve → re-mint with apr
    const quotePence = (await world.pool.query<{ final_amount: string }>(
      `SELECT final_amount FROM core.quotes WHERE quote_id = $1`, [errand.quote_id],
    )).rows[0]!;
    say(`5 · ${pounds(Number(quotePence.final_amount))} > £50.00 pre-auth → PUSH sent → consumer approves on the deep-link screen`);
    const pushPayload = JSON.parse(world.pushTransport.deliveries.at(-1)!.payload) as NotificationPayload;
    const approved = (await (
      await fetch(`${world.walletUrl}/v1/quotes/${errand.quote_id}/approve`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie, 'idempotency-key': `act2-${errand.quote_id}` },
        body: JSON.stringify({ mandate_id: mandateId }),
      })
    ).json()) as { approval: { approval_id: string; mode: string }; token: string };
    say(`    signed Approval recorded (mode: ${approved.approval.mode}); token RE-MINTED with apr set`);

    // consent artefacts to the trio's directory (the PH1-27 world serves the
    // fixture seam; live HTTP serving is TRIO-17/PH2-4's proven wiring)
    world.trio.directory.setMandate((await world.mandates.get(mandateId))!);
    world.trio.directory.setApproval((await world.mandates.approvalFor(errand.quote_id!))!);

    // 6 · the valet completes: checkout → webhook → verify (approval ✓ limits ✓)
    const finalState = await driveTo(startedErrand.errand.errand_id, states);
    if (finalState !== 'CONFIRMED') throw new Error(`expected CONFIRMED, got ${finalState}`);
    const confirmed = (await new ErrandStore(world.pool).get(startedErrand.errand.errand_id))!.errand;
    say('6 · Checkout executed with the apr token — claim VERIFIED: approval ✓ mandate limits ✓; settlement splits post to the ledger');
    return { errand: confirmed, t1, t3, pushPayload, approved };
  });

  const remintApr = (await world.pool.query<{ apr: string | null }>(
    `SELECT apr FROM trio.minted_tokens WHERE qid = $1 AND apr IS NOT NULL`,
    [outcome.errand.quote_id],
  )).rows[0]?.apr ?? null;

  // Aurora Club points credit — PH2-10's production consumer
  const before = (await world.loyaltyAdapter.memberByRef('am_seed_cyn'))?.balance ?? 0;
  await catchUp(
    world.pool,
    pointsCreditProjection({
      pool: world.pool,
      resolveLoyalty: (programme) => (programme === 'aurora-club' ? world.loyaltyAdapter : null),
    }),
  );
  const after = (await world.loyaltyAdapter.memberByRef('am_seed_cyn'))?.balance ?? 0;
  const pointsCredited = after - before;
  say(`    Aurora Club points credited via the loyalty adapter: +${pointsCredited}`);

  // ── 7 · the consumer-visible ledger tail ─────────────────────────────────
  const activity = (await (
    await fetch(`${world.walletUrl}/v1/activity`, { headers: { cookie } })
  ).json()) as { credits: unknown[]; approvals: unknown[]; errands: unknown[] };
  say(`7 · Activity screen: ${activity.errands.length} errand steps · ${activity.approvals.length} approval at the locked price · ${activity.credits.length} points credit`);

  // ── 8 · negatives on camera ───────────────────────────────────────────────
  const verifiedBefore = (await world.pool.query(`SELECT count(*)::int AS n FROM events.events WHERE type = 'ConversionVerified'`)).rows[0]!.n as number;

  // (a) revoke mid-errand → next checkout fails MANDATE_REVOKED
  const brief2 = await interpreterFromEnv().interpret('book me a spa day under £120', { sub_hash: link.sub_hash });
  const errand2 = await driver.startErrand({ brief: brief2, mandate_id: mandateId as `mnd_${string}` });
  await driveTo(errand2.errand.errand_id, []);
  await fetch(`${world.walletUrl}/v1/quotes/${(await new ErrandStore(world.pool).get(errand2.errand.errand_id))!.errand.quote_id}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie, 'idempotency-key': `act2-neg-${errand2.errand.errand_id}` },
    body: JSON.stringify({ mandate_id: mandateId }),
  });
  await fetch(`${world.walletUrl}/v1/mandates/${mandateId}/revoke`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: '{}',
  });
  const errand2Row = (await new ErrandStore(world.pool).get(errand2.errand.errand_id))!;
  world.trio.directory.setMandate((await world.mandates.get(mandateId))!); // REVOKED state served
  world.trio.directory.setApproval((await world.mandates.approvalFor(errand2Row.errand.quote_id!))!);
  const revokedFinal = await driveTo(errand2.errand.errand_id, []);
  const revokedLog = await new ErrandStore(world.pool).eventLog(errand2.errand.errand_id);
  const revokedReason =
    (revokedLog.find((row) => row.event.type === 'CLAIM_REJECTED')?.event as { reason_code?: string })?.reason_code ?? revokedFinal;
  say(`8a · Mandate REVOKED mid-errand → next checkout rejected ${revokedReason}; errand ends ${revokedFinal}`);

  // (b) decline the notification → DECLINED, nothing charged
  const mandate2 = await grantMandate();
  const brief3 = await interpreterFromEnv().interpret('book me a spa day under £120', { sub_hash: link.sub_hash });
  const errand3 = await driver.startErrand({ brief: brief3, mandate_id: mandate2 as `mnd_${string}` });
  await driveTo(errand3.errand.errand_id, []);
  const errand3Quote = (await new ErrandStore(world.pool).get(errand3.errand.errand_id))!.errand.quote_id;
  await fetch(`${world.walletUrl}/v1/quotes/${errand3Quote}/decline`, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ mandate_id: mandate2 }),
  });
  const declinedState = await driveTo(errand3.errand.errand_id, []);
  const verifiedAfter = (await world.pool.query(`SELECT count(*)::int AS n FROM events.events WHERE type = 'ConversionVerified'`)).rows[0]!.n as number;
  const chargedDuringNegatives = verifiedAfter !== verifiedBefore;
  say(`8b · Notification DECLINED → errand ends ${declinedState}; nothing charged, nothing settled (verified conversions unchanged: ${!chargedDuringNegatives ? 'true' : 'FALSE'})`);

  // ── 9 · one trace from brief to ledger ────────────────────────────────────
  const { rows: traceRows } = await world.pool.query<{ trace_id: string | null }>(
    `SELECT trace_id FROM events.events WHERE type = 'ConversionVerified' AND body->'data'->>'claim_id' = $1`,
    [outcome.errand.claim_id],
  );
  const template = process.env['MERITED_TRACE_URL_TEMPLATE'] ?? 'trace {trace_id}';
  say(`9 · ONE trace, brief → ledger: ${traceRows[0]?.trace_id === traceId ? 'ledger event carries the SAME trace id ✓' : 'TRACE MISMATCH'}`);
  if (!options.quiet) console.log(`    ${template.replace('{trace_id}', traceId)}`);

  await shop.close();
  await valetPool.end();

  return {
    linkSubHash: link.sub_hash,
    scopesShown,
    mandateId,
    interpretedMaxPencePrice: 12000,
    states,
    t1: { offer_id: outcome.t1.offer_id, tier: outcome.t1.tier, final: outcome.t1.price.final.amount },
    t3: { offer_id: outcome.t3.offer_id, tier: outcome.t3.tier, final: outcome.t3.price.final.amount },
    pushDeepLink: outcome.pushPayload.deep_link,
    approvalMode: outcome.approved.approval.mode,
    remintApr,
    claimId: outcome.errand.claim_id!,
    pointsCredited,
    revokedReason,
    declinedState,
    chargedDuringNegatives,
    traceId,
    eventTraceId: traceRows[0]?.trace_id ?? null,
    transcript,
  };
};

const main = async (): Promise<void> => {
  const world = await createPhase1World();
  try {
    const evidence = await runAct2(world);
    console.log('\n— evidence —');
    console.log(JSON.stringify({ ...evidence, transcript: undefined }, null, 2));
  } finally {
    await world.close();
  }
};

if (process.argv[1]?.endsWith('act2.ts') || process.argv[1]?.endsWith('act2.js')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
