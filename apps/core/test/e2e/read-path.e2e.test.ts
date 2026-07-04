import { AttributionTokenClaims, newId } from '@merited/contracts';
import { createSimulatedCore, type SimulatedCore } from '@merited/core/testing';
import { canonicalJson } from '@merited/events';
import { getMemoryExporter, initOtel, shutdownOtel, withSpan } from '@merited/otel';
import { MeritedClient } from '@merited/sdk';
import { FakeSigner } from '@merited/signing';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../../trio/scripts/migrate.mjs';
// VAL-9's seed, imported by SOURCE path: a package edge apps/core →
// @merited/seed would close a workspace dependency cycle (seed already
// depends on core), so the gate slice reaches across the repo instead.
import { runSeed } from '../../../../tools/seed/src/seed.js';
import {
  AURORA_MEMBERS,
  AURORA_MERCHANT_ID,
  AURORA_OFFERS,
} from '../../../../tools/seed/src/fixtures/aurora.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_gate_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'gate-e2e';
const SIGNER_SECRET = 'trio-test-secret';
const signer = new FakeSigner(SIGNER_SECRET);

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let core: SimulatedCore;
let coreUrl: string;
let merchantKey: string;
let signingKeyRef: string;
let bountyCommitmentId: string;
let sdk: MeritedClient;
let agentId: string;

const goldMember = AURORA_MEMBERS.find((m) => m.loyalty_tier === 'Gold' && m.status === 'active')!;
const spaOffer = AURORA_OFFERS.find((f) => f.bounty)!;

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const decodeClaims = (token: string): AttributionTokenClaims =>
  AttributionTokenClaims.parse(
    JSON.parse(Buffer.from(token.split('.')[3]!, 'base64url').toString('utf8')),
  );

const signedClaimFor = async (token: string, gross: { amount: number; currency: 'GBP_pence' }, tsOffsetS = 30) => {
  const base = {
    claim_id: newId('clm'),
    merchant_id: AURORA_MERCHANT_ID,
    attribution_token: token,
    order: {
      order_ref_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      gross_value: gross,
      ts: iso(tsOffsetS),
    },
  };
  const merchant_sig = await signer.sign(signingKeyRef, canonicalJson(base));
  return { ...base, merchant_sig };
};

beforeAll(async () => {
  initOtel({ serviceName: 'read-path-e2e', exporter: 'memory' });
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  await migrateTrio(adminUrl);
  const appUrl = `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;
  pool = new pg.Pool({ connectionString: appUrl, max: 10 });
  pool.on('error', () => {});

  // Step 1 — VAL-9 fixtures through the REAL seed: Aurora published with the
  // £12.00 fixed-CPA bounty, COR countersigned by the commitment simulator.
  const seeded = await runSeed({
    databaseUrl: appUrl,
    serviceToken: SERVICE_TOKEN,
    signerSecret: SIGNER_SECRET,
    log: () => {},
  });
  bountyCommitmentId = seeded.bounty_commitment_id!;

  trio = createSimulatedTrio({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signerSecret: SIGNER_SECRET });
  const trioUrl = await trio.listen();
  core = createSimulatedCore({
    databaseUrl: appUrl,
    trioBaseUrl: trioUrl,
    trioServiceToken: SERVICE_TOKEN,
    signerSecret: SIGNER_SECRET,
  });
  coreUrl = await core.listen();

  signingKeyRef = (await core.merchants.get(AURORA_MERCHANT_ID)).signing_key_ref!;
  merchantKey = (await core.merchants.issueApiKey(AURORA_MERCHANT_ID)).api_key;
  sdk = new MeritedClient({ baseUrl: coreUrl, merchantApiKey: merchantKey });
});

afterAll(async () => {
  await core.close();
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
  await shutdownOtel();
});

describe('read-path e2e (CORE-14 accept — the CORE slice of the §9 Phase 0 gate)', () => {
  let happyToken: string;
  let happyQid: string;

  it('step 1: the seeded £12.00 fixed-CPA offer is live with a COUNTERSIGNED COR', async () => {
    expect(bountyCommitmentId).toMatch(/^com_/);
    const { rows } = await pool.query(
      `SELECT body->'data'->'commitment' AS commitment FROM events.events WHERE type = 'CommitmentCreated'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].commitment).toMatchObject({
      commitment_id: bountyCommitmentId,
      merchant_id: AURORA_MERCHANT_ID,
      bounty: { type: 'fixed', amount: { amount: 1200, currency: 'GBP_pence' } },
    });
    expect(rows[0].commitment.merchant_sig).toBeTruthy();
    expect(rows[0].commitment.platform_sig).toBeTruthy();
  });

  it('steps 2+6: registered read → quote-bound token under ONE trace with the mint; claims decode; qid resolves', async () => {
    getMemoryExporter()!.reset();
    await withSpan('read-path-e2e', async () => {
      agentId = (await sdk.register({ name: 'Valet', contact: 'valet@example.test' })).agent_id;
      const read = await sdk.readOffers({ text: 'spa', sub_hash: goldMember.sub_hash });
      const quote = read.quotes.find((q) => q.offer_id === spaOffer.offer_id)!;
      expect(quote.token).not.toBeNull();
      happyToken = quote.token!;
      happyQid = quote.quote_id;
      expect(quote.price.final.amount).toBe(8450); // D7 anchor
    });

    // §8/B21: read → mint share ONE trace (verify joins it in step 4's span
    // continuation below; snapshot NOW before other instrumented calls)
    const spans = [...getMemoryExporter()!.getFinishedSpans()];
    expect(spans.length).toBeGreaterThanOrEqual(4);
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);

    // decoded claims: qid resolves via GET /v1/quotes/:id; apr null; tier T1
    const claims = decodeClaims(happyToken);
    expect(claims.cid).toBe(bountyCommitmentId);
    expect(claims.aid).toBe(agentId);
    expect(claims.apr).toBeNull(); // walletless Phase 0
    expect(claims.tier).toBe('T1'); // seeded Gold member matched by sub_hash
    const status = await sdk.getQuote(claims.qid);
    expect(status.status).toBe('live');
    expect(status.quote.quote_id).toBe(happyQid);
    expect(status.quote.commitment_id).toBe(bountyCommitmentId);
  });

  it('step 3: anonymous read → token: null + register_to_earn hint (B4)', async () => {
    const anonymous = new MeritedClient({ baseUrl: coreUrl });
    const read = await anonymous.readOffers({ text: 'spa' });
    expect(read.quotes.length).toBeGreaterThanOrEqual(1);
    expect(read.quotes.every((q) => q.token === null)).toBe(true);
    expect(read.hint).toMatchObject({ register_to_earn: true });
  });

  it('steps 4+6: valid claim → verified; quote flips to converted; verify joined the SAME trace', async () => {
    getMemoryExporter()!.reset();
    let traceId = '';
    await withSpan('claim-span', async (span) => {
      traceId = span.spanContext().traceId;
      const submitted = await sdk.submitClaim(
        await signedClaimFor(happyToken, { amount: 8450, currency: 'GBP_pence' }),
        { idempotencyKey: newId('clm') },
      );
      expect(submitted.verdict).toBe('verified');
    });
    const spans = [...getMemoryExporter()!.getFinishedSpans()];
    expect(new Set(spans.map((s) => s.spanContext().traceId))).toEqual(new Set([traceId]));

    const status = await sdk.getQuote(happyQid);
    expect(status.status).toBe('converted'); // §5.6a via ConversionVerified
  });

  it('step 5a: replaying the same token → TOKEN_REPLAYED on the same rails', async () => {
    const replay = await sdk.submitClaim(
      await signedClaimFor(happyToken, { amount: 8450, currency: 'GBP_pence' }),
      { idempotencyKey: newId('clm') },
    );
    expect(replay).toMatchObject({ verdict: 'rejected', reason_code: 'TOKEN_REPLAYED' });
  });

  it('step 5b: claim against an expired quote → QUOTE_EXPIRED (clock advanced via public inputs)', async () => {
    const read = await sdk.readOffers({ text: 'spa', sub_hash: goldMember.sub_hash });
    const fresh = read.quotes.find((q) => q.offer_id === spaOffer.offer_id)!;
    const expired = await sdk.submitClaim(
      // order ts 700s ahead — inside the attribution window, past the ≤600s quote snapshot
      await signedClaimFor(fresh.token!, { amount: 8450, currency: 'GBP_pence' }, 700),
      { idempotencyKey: newId('clm') },
    );
    expect(expired).toMatchObject({ verdict: 'rejected', reason_code: 'QUOTE_EXPIRED' });
  });
});
