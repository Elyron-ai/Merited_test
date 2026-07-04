import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId, pence, type CommitmentDraft } from '@merited/contracts';
import { FakeSigner } from '@merited/signing';
import fc from 'fast-check';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../packages/events/scripts/migrate.mjs';
import { CommitmentSimulator } from '../commitment/simulator.js';
import { registerCommitmentRoutes } from '../commitment/routes.js';
import { systemClock } from '../shared/clock.js';
import { merchantKeyRef } from '../shared/deps.js';
import { FixtureDirectory, VerifiedDirectory } from '../shared/ports/directory.js';
import { createTrioServer } from '../shared/server.js';
import { MintSimulator } from '../verification/simulator.js';
import { registerMintRoutes, registerVerifyRoutes } from '../verification/routes.js';
import { claimSignaturePayload, VerifySimulator } from '../verification/verify-pipeline.js';
import { monthKey } from './posting.js';
import { registerSettlementRoutes } from './routes.js';
import { SettlementSimulator } from './simulator.js';
import { partyForAccount } from './statements.js';

/**
 * TRIO-12 — spec §7.3 accept, verbatim: "trial balance sums to zero after
 * any generated sequence of verify/reverse/net operations (property test)".
 * Arbitrary interleaved commitment-create / mint / verify / reverse /
 * netting-run sequences (valid AND invalid) run against the HTTP surface —
 * the same property gates the real implementations (PH1-24…26) untouched.
 */

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_tb_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'trial-balance-test-token';
const signer = new FakeSigner('trio-test-secret');

const MERCHANTS = [newId('mer'), newId('mer')] as const;
const AGENTS = [newId('agt'), newId('agt'), newId('agt')] as const;
const TIERS = ['T1', 'T2', 'T3'] as const;
const ORDER_HASH = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

// ── op generators: valid and invalid inputs both land in the pot ───────────
const createOp = fc.record({
  type: fc.constant('create' as const),
  merchantPick: fc.nat(1),
  fixedBounty: fc.boolean(),
  fixedPence: fc.integer({ min: 1, max: 5000 }),
  pctBps: fc.integer({ min: 1, max: 10000 }),
  takeBps: fc.integer({ min: 0, max: 4000 }),
  commissionBps: fc.integer({ min: 0, max: 6000 }),
  maxConversions: fc.option(fc.integer({ min: 1, max: 3 }), { nil: null }),
  budgetPence: fc.option(fc.integer({ min: 100, max: 4000 }), { nil: null }),
  attributionWindowS: fc.constantFrom(30, 600, 86400),
  clawbackWindowS: fc.constantFrom(0, 3600, 2592000),
  restrictedTiers: fc.boolean(),
  notYetValid: fc.boolean(),
});

const mintOp = fc.record({
  type: fc.constant('mint' as const),
  commitmentIdx: fc.nat(),
  agentPick: fc.nat(2),
  tierPick: fc.nat(2),
  quoteExpS: fc.integer({ min: 10, max: 900 }),
});

const verifyOp = fc.record({
  type: fc.constant('verify' as const),
  tokenIdx: fc.nat(),
  grossPence: fc.integer({ min: 1, max: 30000 }),
  tsOffsetS: fc.integer({ min: -60, max: 900 }),
  tamperSig: fc.boolean(),
});

const reverseOp = fc.record({
  type: fc.constant('reverse' as const),
  claimIdx: fc.nat(),
  unknownClaim: fc.boolean(),
  wrongMerchant: fc.boolean(),
});

const netOp = fc.record({
  type: fc.constant('net' as const),
  invalidPeriod: fc.boolean(),
});

const opArb = fc.oneof(
  { arbitrary: createOp, weight: 3 },
  { arbitrary: mintOp, weight: 4 },
  { arbitrary: verifyOp, weight: 5 },
  { arbitrary: reverseOp, weight: 3 },
  { arbitrary: netOp, weight: 2 },
);
type Op = typeof opArb extends fc.Arbitrary<infer T> ? T : never;

let admin: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;

// Model state persists across sequences — the DB accumulates too, which only
// strengthens the invariant (it must hold over ALL history, not a clean slate).
const knownCommitments: Array<{ cid: `com_${string}`; merchantId: `mer_${string}` }> = [];
const knownTokens: Array<{ token: string; merchantId: `mer_${string}` }> = [];
const knownClaims: Array<{ claimId: `clm_${string}`; merchantId: `mer_${string}` }> = [];

const inject = async (
  method: 'POST' | 'GET',
  url: string,
  payload?: unknown,
): Promise<{ statusCode: number; body: Record<string, unknown> }> => {
  const response = await app.inject({
    method,
    url,
    headers: {
      'x-merited-service-token': SERVICE_TOKEN,
      ...(method === 'POST' ? { 'idempotency-key': newId('clm') } : {}),
    },
    ...(payload === undefined ? {} : { payload: payload as never }),
  });
  if (response.statusCode >= 500) {
    throw new Error(`unexpected ${response.statusCode} from ${method} ${url}: ${response.body}`);
  }
  return { statusCode: response.statusCode, body: response.json() };
};

const applyOp = async (op: Op): Promise<void> => {
  if (op.type === 'create') {
    const merchantId = MERCHANTS[op.merchantPick]!;
    const draft: CommitmentDraft = {
      merchant_id: merchantId,
      offer_ref: newId('off'),
      bounty: op.fixedBounty
        ? { type: 'fixed', amount: pence(op.fixedPence) }
        : { type: 'pct_of_order', pct_bps: op.pctBps },
      take_rate_bps: op.takeBps,
      agent_commission_bps: op.commissionBps,
      terms: {
        attribution_window_s: op.attributionWindowS,
        eligible_identity_tiers: op.restrictedTiers ? ['T1'] : ['T1', 'T2', 'T3'],
        max_conversions: op.maxConversions,
        clawback_window_s: op.clawbackWindowS,
        valid_from: iso(op.notYetValid ? 3600 : -86400),
        valid_until: iso(30 * 86400),
      },
      ...(op.budgetPence === null ? {} : { budget: pence(op.budgetPence) }),
    };
    const { statusCode, body } = await inject('POST', '/trio/commitments', draft);
    if (statusCode === 200) {
      const commitment = body['commitment'] as { commitment_id: `com_${string}` };
      knownCommitments.push({ cid: commitment.commitment_id, merchantId });
    }
    return;
  }

  if (op.type === 'mint') {
    if (knownCommitments.length === 0) return;
    const target = knownCommitments[op.commitmentIdx % knownCommitments.length]!;
    const { statusCode, body } = await inject('POST', '/trio/tokens/mint', {
      cid: target.cid,
      qid: newId('qte'),
      aid: AGENTS[op.agentPick]!,
      tier: TIERS[op.tierPick]!,
      session_nonce: 'n',
      quote: { expires_at: iso(op.quoteExpS), mandate_ref: null },
    });
    if (statusCode === 200) {
      knownTokens.push({ token: body['token'] as string, merchantId: target.merchantId });
    }
    return;
  }

  if (op.type === 'verify') {
    if (knownTokens.length === 0) return;
    const target = knownTokens[op.tokenIdx % knownTokens.length]!;
    const base = {
      claim_id: newId('clm'),
      merchant_id: target.merchantId,
      attribution_token: target.token,
      order: {
        order_ref_hash: ORDER_HASH,
        gross_value: pence(op.grossPence),
        ts: iso(op.tsOffsetS),
      },
    };
    const merchant_sig = await signer.sign(
      merchantKeyRef(base.merchant_id),
      claimSignaturePayload(base),
    );
    const claim = {
      ...base,
      merchant_sig: op.tamperSig ? merchant_sig.slice(0, -2) + 'ff' : merchant_sig,
    };
    const { statusCode, body } = await inject('POST', '/trio/claims/verify', claim);
    if (statusCode === 200 && body['verdict'] === 'verified') {
      knownClaims.push({ claimId: base.claim_id, merchantId: target.merchantId });
    }
    return;
  }

  if (op.type === 'reverse') {
    const target =
      op.unknownClaim || knownClaims.length === 0
        ? { claimId: newId('clm'), merchantId: MERCHANTS[0]! }
        : knownClaims[op.claimIdx % knownClaims.length]!;
    const merchantId = op.wrongMerchant ? MERCHANTS[1]! : target.merchantId;
    const base = { claim_id: target.claimId, merchant_id: merchantId };
    const merchant_sig = await signer.sign(merchantKeyRef(merchantId), claimSignaturePayload(base));
    await inject('POST', '/trio/claims/reverse', { ...base, merchant_sig });
    return;
  }

  await inject('POST', '/trio/netting/run', {
    period: op.invalidPeriod ? '2026-13' : monthKey(new Date()),
  });
};

/** The §7.3 invariant pair, checked after every generated sequence. */
const assertInvariants = async (): Promise<void> => {
  const trial = await pool.query<{ imbalance: string }>(
    `SELECT COALESCE(SUM(CASE WHEN side = 'dr' THEN amount_pence ELSE -amount_pence END), 0) AS imbalance
       FROM trio.entry_lines`,
  );
  expect(Number(trial.rows[0]!.imbalance)).toBe(0);

  const byAccount = await pool.query<{ account: string; signed: string }>(
    `SELECT account,
            SUM(CASE WHEN side = 'cr' THEN amount_pence ELSE -amount_pence END) AS signed
       FROM trio.entry_lines
      GROUP BY account`,
  );
  const byParty = new Map<string, number>();
  for (const row of byAccount.rows) {
    const party = partyForAccount(row.account);
    byParty.set(party, (byParty.get(party) ?? 0) + Number(row.signed));
  }
  for (const [party, signed] of byParty) {
    const { statusCode, body } = await inject('GET', `/trio/positions/${party}`);
    expect(statusCode).toBe(200);
    expect(body).toEqual({
      party,
      direction: signed >= 0 ? 'receivable' : 'payable',
      amount: { currency: 'GBP_pence', amount: Math.abs(signed) },
    });
  }
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateTrio(adminUrl);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 10,
  });
  pool.on('error', () => {});
  const deps = { pool, signer, clock: systemClock };
  const commitments = new CommitmentSimulator(deps);
  app = createTrioServer({ serviceToken: SERVICE_TOKEN });
  registerCommitmentRoutes(app, commitments);
  registerMintRoutes(app, new MintSimulator(deps, commitments));
  registerVerifyRoutes(app, new VerifySimulator(deps, new VerifiedDirectory(new FixtureDirectory(), signer)));
  registerSettlementRoutes(app, new SettlementSimulator(deps));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('trial-balance-zero property (TRIO-12 accept)', () => {
  it('Σ(debits) − Σ(credits) = 0 and positions equal line sums after ANY sequence (≥500 runs)', async () => {
    const details = await fc.check(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 10 }), async (ops) => {
        for (const op of ops) await applyOp(op);
        await assertInvariants();
      }),
      { numRuns: 500 },
    );
    if (details.failed) {
      // Accept clause: shrunk counter-examples are reported as fixtures.
      const fixtureDir = path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '__fixtures__',
      );
      mkdirSync(fixtureDir, { recursive: true });
      const fixturePath = path.join(fixtureDir, 'trial-balance.counterexample.json');
      writeFileSync(
        fixturePath,
        JSON.stringify(
          { seed: details.seed, path: details.counterexamplePath, ops: details.counterexample },
          null,
          2,
        ),
      );
      expect.fail(
        `trial-balance property failed (seed ${details.seed}); shrunk counter-example written to ${fixturePath}: ${String(details.errorInstance)}`,
      );
    }
    expect(details.numRuns).toBeGreaterThanOrEqual(500);
  }, 600_000);
});
