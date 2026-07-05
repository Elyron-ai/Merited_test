import {
  CommitmentCreateResponse,
  MintResponse,
  newId,
  pence,
  ReverseResponse,
  VerifyResponse,
  type Approval,
  type Commitment,
  type CommitmentDraft,
  type Mandate,
} from '@merited/contracts';
import { canonicalJson } from '@merited/events';
import { FakeSigner, type Signer } from '@merited/signing';
import type pg from 'pg';

/**
 * TRIO-13 harness — the ONLY module the contract tests may import from this
 * app (rules.test.ts enforces it statically). The suite is target-driven:
 *
 *   TRIO_TARGET_URL unset  → boot the simulators in-process against the
 *                            docker-compose Postgres (fresh database) and
 *                            speak real HTTP to them.
 *   TRIO_TARGET_URL set    → run the SAME tests against that base URL with
 *                            zero test edits (spec §7 accept; XC-12 flips
 *                            this to the real implementations in Phase 1).
 *
 * Remote-target caveats, by design:
 *  - `db` is null: DB-level assertions (event emission, chain verification)
 *    are `skipIf`-gated — they are properties of a deployment the suite owns.
 *  - `directory` is null: stage-6 wallet-path fixtures need the directory
 *    fake; TRIO-17 (Phase 1) wires the live wallet directory and PH1-27
 *    proves that path full-dress. All directory-FREE negatives (including
 *    the SYN-8 APPROVAL_MISSING guard) still run remotely.
 *  - The signer comes from `MERITED_TEST_SIGNER_SECRET` (FakeSigner in
 *    Phase 0). PH1-30 adds a real-Ed25519 branch HERE — a harness change,
 *    never a test-file change (XC-7 zero-edit rule).
 */

/** Wire conventions the suite locks from the OUTSIDE (never imported). */
export const merchantKey = (merchantId: string): string => `merchant/${merchantId}`;

export interface TrioDirectoryHandle {
  setApproval(approval: Approval): void;
  setMandate(mandate: Mandate): void;
  revokeMandate(mandateId: string): void;
}

export interface TrioTarget {
  baseUrl: string;
  serviceToken: string;
  signer: Signer;
  /** Non-null only when the harness booted the target itself. */
  db: pg.Pool | null;
  /** Non-null only when the harness booted the target itself. */
  directory: TrioDirectoryHandle | null;
  /** Reads the pipeline has made against the directory (PH1-2's
   * walletless-never-touches-approvals proof). Null on remote targets. */
  directoryReads: (() => number) | null;
  attest<T extends Record<string, unknown>>(record: Omit<T, 'attestation'>): Promise<T>;
  close(): Promise<void>;
}

export interface HttpResult {
  status: number;
  body: unknown;
  /** Raw response text — byte-identity assertions (idempotency) use this. */
  text: string;
  contentType: string;
}

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';

export const createTarget = async (): Promise<TrioTarget> => {
  const signer = new FakeSigner(process.env['MERITED_TEST_SIGNER_SECRET'] ?? 'trio-test-secret');
  const remote = process.env['TRIO_TARGET_URL'];

  if (remote) {
    const serviceToken = process.env['MERITED_TRIO_SERVICE_TOKEN'];
    if (!serviceToken) {
      throw new Error('TRIO_TARGET_URL is set but MERITED_TRIO_SERVICE_TOKEN is not');
    }
    return {
      baseUrl: remote.replace(/\/$/, ''),
      serviceToken,
      signer,
      db: null,
      directory: null,
      directoryReads: null,
      attest: () => {
        throw new Error('directory fixtures are unavailable against a remote target (TRIO-17)');
      },
      close: async () => {},
    };
  }

  // In-process boot. Simulator code loads ONLY on this branch — a remote run
  // never touches apps/trio/src at runtime.
  const { default: pgDriver } = await import('pg');
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — plain-JS script module
  const { migrateTrio } = await import('../scripts/migrate.mjs');
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — plain-JS script module
  const { migrate } = await import('../../../packages/events/scripts/migrate.mjs');
  const { CommitmentSimulator } = await import('../src/commitment/simulator.js');
  const { MintSimulator, VerifySimulator } = await import('../src/verification/simulator.js');
  const { SettlementSimulator } = await import('../src/settlement/simulator.js');
  const { registerCommitmentRoutes } = await import('../src/commitment/routes.js');
  const { registerMintRoutes, registerVerifyRoutes } = await import('../src/verification/routes.js');
  const { registerSettlementRoutes } = await import('../src/settlement/routes.js');
  const { createTrioServer } = await import('../src/shared/server.js');
  const { systemClock } = await import('../src/shared/clock.js');
  const { FixtureDirectory, VerifiedDirectory, attest } = await import(
    '../src/shared/ports/directory.js'
  );

  const dbName = `merited_ct_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const admin = new pgDriver.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateTrio(adminUrl);
  const pool = new pgDriver.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 10,
  });
  pool.on('error', () => {});

  const serviceToken = 'contract-test-service-token';
  const deps = { pool, signer, clock: systemClock };
  const commitments = new CommitmentSimulator(deps);
  const fixtures = new FixtureDirectory();
  const app = createTrioServer({ serviceToken });
  registerCommitmentRoutes(app, commitments);
  registerMintRoutes(app, new MintSimulator(deps, commitments));
  // Count every directory consultation at the pipeline's own boundary —
  // the walletless path must show a delta of ZERO (PH1-2).
  const verified = new VerifiedDirectory(fixtures, signer);
  let directoryReadCount = 0;
  const countingDirectory = {
    getApproval: (id: string) => {
      directoryReadCount += 1;
      return verified.getApproval(id);
    },
    getMandate: (id: string) => {
      directoryReadCount += 1;
      return verified.getMandate(id);
    },
  };
  registerVerifyRoutes(app, new VerifySimulator(deps, countingDirectory));
  // Host-level Chromium resolution for the PDF route (the trio itself takes
  // this via constructor options — no ambient env inside the services).
  const { existsSync } = await import('node:fs');
  const chromiumPath =
    process.env['MERITED_CHROMIUM_PATH'] ??
    (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);
  registerSettlementRoutes(
    app,
    new SettlementSimulator(deps),
    chromiumPath ? { chromiumPath } : {},
  );
  const baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });

  return {
    baseUrl,
    serviceToken,
    signer,
    db: pool,
    directory: fixtures,
    directoryReads: () => directoryReadCount,
    attest: (record) => attest(signer, record),
    close: async () => {
      await app.close();
      await pool.end();
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    },
  };
};

// ── HTTP client (fetch — identical wire path for local and remote) ─────────

export const request = async (
  target: TrioTarget,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH',
  path: string,
  options: { body?: unknown; headers?: Record<string, string>; token?: string | null } = {},
): Promise<HttpResult> => {
  const response = await fetch(`${target.baseUrl}${path}`, {
    method,
    headers: {
      ...(options.token === null
        ? {}
        : { 'x-merited-service-token': options.token ?? target.serviceToken }),
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(options.headers ?? {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body: unknown = undefined;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return {
    status: response.status,
    body,
    text,
    contentType: response.headers.get('content-type') ?? '',
  };
};

// ── contract-schema response parsers (the schemas ARE the assertions) ──────

export const expectStatus = (result: HttpResult, status: number): HttpResult => {
  if (result.status !== status) {
    throw new Error(`expected HTTP ${status}, got ${result.status}: ${result.text}`);
  }
  return result;
};

export const asCommitment = (result: HttpResult): Commitment =>
  CommitmentCreateResponse.parse(expectStatus(result, 200).body).commitment;

export const asMint = (result: HttpResult): MintResponse =>
  MintResponse.parse(expectStatus(result, 200).body);

export const asVerify = (result: HttpResult): VerifyResponse =>
  VerifyResponse.parse(expectStatus(result, 200).body);

export const asReverse = (result: HttpResult): ReverseResponse =>
  ReverseResponse.parse(expectStatus(result, 200).body);

export const fetchPdf = async (
  target: TrioTarget,
  path: string,
): Promise<{ status: number; contentType: string; bytes: Buffer }> => {
  const response = await fetch(`${target.baseUrl}${path}`, {
    headers: { 'x-merited-service-token': target.serviceToken },
  });
  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    bytes: Buffer.from(await response.arrayBuffer()),
  };
};

// ── fixture builders (fresh ids per suite run — remote-target safe) ────────

export const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

export const ORDER_HASH = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';

export const draftFor = (
  merchantId: `mer_${string}`,
  overrides: Partial<CommitmentDraft['terms']> = {},
  extra: Partial<CommitmentDraft> = {},
): CommitmentDraft => ({
  merchant_id: merchantId,
  offer_ref: newId('off'),
  bounty: { type: 'fixed', amount: pence(1200) },
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  terms: {
    attribution_window_s: 86400,
    eligible_identity_tiers: ['T1', 'T2', 'T3'],
    max_conversions: 500,
    clawback_window_s: 2592000,
    valid_from: iso(-86400),
    valid_until: iso(180 * 86400),
    ...overrides,
  },
  ...extra,
});

export const createCommitment = async (
  target: TrioTarget,
  draft: CommitmentDraft,
): Promise<Commitment> =>
  asCommitment(await request(target, 'POST', '/trio/commitments', { body: draft }));

/** Sign a conversion claim exactly as a merchant would: canonical JSON of the
 * claim minus `merchant_sig`, under the fixture merchant key. */
export const signClaim = async <T extends { merchant_id: string }>(
  target: TrioTarget,
  base: T,
): Promise<T & { merchant_sig: string }> => ({
  ...base,
  merchant_sig: await target.signer.sign(merchantKey(base.merchant_id), canonicalJson(base)),
});

export const claimFor = async (
  target: TrioTarget,
  merchantId: `mer_${string}`,
  token: string,
  opts: { grossPence?: number; tsOffsetS?: number } = {},
) =>
  signClaim(target, {
    claim_id: newId('clm'),
    merchant_id: merchantId,
    attribution_token: token,
    order: {
      order_ref_hash: ORDER_HASH,
      gross_value: pence(opts.grossPence ?? 8450),
      ts: iso(opts.tsOffsetS ?? 10),
    },
  });

export const mintFor = async (
  target: TrioTarget,
  cid: string,
  opts: {
    agentId?: `agt_${string}`;
    tier?: 'T1' | 'T2' | 'T3';
    qid?: `qte_${string}`;
    apr?: `apr_${string}`;
    quoteExpS?: number;
    mandateRef?: `mnd_${string}` | null;
  } = {},
): Promise<HttpResult> =>
  request(target, 'POST', '/trio/tokens/mint', {
    body: {
      cid,
      qid: opts.qid ?? newId('qte'),
      aid: opts.agentId ?? newId('agt'),
      tier: opts.tier ?? 'T3',
      session_nonce: 'contract-suite',
      ...(opts.apr ? { apr: opts.apr } : {}),
      quote: { expires_at: iso(opts.quoteExpS ?? 300), mandate_ref: opts.mandateRef ?? null },
    },
  });

export const verifyClaim = async (
  target: TrioTarget,
  claim: unknown,
  idempotencyKey = newId('clm'),
): Promise<HttpResult> =>
  request(target, 'POST', '/trio/claims/verify', {
    body: claim,
    headers: { 'idempotency-key': idempotencyKey },
  });

export const reverseFor = async (
  target: TrioTarget,
  merchantId: `mer_${string}`,
  claimId: `clm_${string}`,
  reason?: string,
): Promise<HttpResult> =>
  request(target, 'POST', '/trio/claims/reverse', {
    body: await signClaim(target, {
      claim_id: claimId,
      merchant_id: merchantId,
      ...(reason ? { reason } : {}),
    }),
  });

/** Position as a signed pence value (credit positive) — HTTP-only view. */
export const signedPosition = async (target: TrioTarget, party: string): Promise<number> => {
  const { status, body } = await request(target, 'GET', `/trio/positions/${party}`);
  if (status !== 200) throw new Error(`positions/${party} → ${status}`);
  const position = body as { direction: 'payable' | 'receivable'; amount: { amount: number } };
  return position.direction === 'receivable' ? position.amount.amount : -position.amount.amount;
};
