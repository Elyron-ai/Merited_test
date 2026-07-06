import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PROOF_PACK_FORMAT,
  pence,
  type CommitmentDraft,
  type ConversionClaim,
  type ProofPack,
} from '@merited/contracts';
import { seededIdFactory } from '@merited/contracts/testing';
import { FakeObjectStore, appendEventInNewTx, publishHead } from '@merited/events';
import { Ed25519Signer, InMemoryKeyStore, InMemoryKms } from '@merited/signing';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../../apps/trio/scripts/migrate.mjs';
import { CommitmentSimulator, MerchantKeySimulator } from '../../../apps/trio/src/commitment/simulator.js';
import { systemClock } from '../../../apps/trio/src/shared/clock.js';
import { FixtureDirectory, VerifiedDirectory } from '../../../apps/trio/src/shared/ports/directory.js';
import { InMemoryReplayCache } from '../../../apps/trio/src/shared/replay-cache.js';
import { claimSignaturePayload, MintSimulator, VerifySimulator } from '../../../apps/trio/src/verification/simulator.js';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { canonicalize } from 'json-canonicalize';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyProofPack, type TrustAnchor } from '../src/verify.js';

/** The auditor's out-of-band trust anchor (W12/#3): the REAL published head +
 * the REAL platform keys. In production these come from the trusted heads store
 * and the key manifest; here the genuine pack IS the real ledger, so deriving
 * the anchor from it models exactly what the auditor would have fetched. */
const trustFor = (pack: ProofPack): TrustAnchor => ({
  heads: pack.heads.map((h) => ({ seq: h.seq, head_hash: h.head_hash })),
  platform: {
    commitment_public_key: pack.keys.platform_commitment_public_key,
    mint_public_key: pack.keys.platform_mint_public_key,
  },
});

/**
 * PH3-8 accept: a REAL conversion (real Ed25519 COR signatures, real PASETO
 * token, the trio's own verdict) is exported as a merited-proof-pack/1 and
 * verified OFFLINE by the reference implementation — which imports nothing
 * from the platform. Tamper matrix: ANY mutated event byte fails, plus
 * forged claims, swapped keys, missing anchors and the dev fake format.
 * The clean-container run (network egress disabled) is recorded for the
 * gate in docs/gates/.
 */

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_verif_${Date.now().toString(36)}`;
const ids = seededIdFactory(3801);

let admin: pg.Client;
let pool: pg.Pool;
let signer: Ed25519Signer;
let commitments: CommitmentSimulator;
let mint: MintSimulator;
let verifier: VerifySimulator;

const merchantId = ids.next('mer');
const agentId = ids.next('agt');

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const draftFor = (): CommitmentDraft => ({
  merchant_id: merchantId,
  offer_ref: ids.next('off'),
  bounty: { type: 'fixed', amount: pence(1200) },
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  terms: {
    max_conversions: 500,
    attribution_window_s: 86400,
    clawback_window_s: 2592000,
    eligible_identity_tiers: ['T1', 'T2', 'T3'],
    valid_from: iso(-86400),
    valid_until: iso(180 * 86400),
  },
});

const spkiBase64 = (keyRef: string): Promise<string> =>
  signer.usePublicKey(keyRef, async (publicKey) =>
    (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64'),
  );

/** One REAL conversion end-to-end; returns the assembled proof pack. */
const buildPack = async (): Promise<ProofPack> => {
  const cor = (await commitments.create(draftFor())).commitment;
  const minted = await mint.mint({
    cid: cor.commitment_id as `com_${string}`,
    qid: ids.next('qte'),
    aid: agentId,
    tier: 'T1',
    session_nonce: `nonce-${ids.next('atk')}`,
    quote: { expires_at: iso(300), mandate_ref: null },
  });

  const base = {
    claim_id: ids.next('clm'),
    merchant_id: merchantId,
    attribution_token: minted.token,
    order: { order_ref_hash: 'f'.repeat(64), gross_value: pence(8450), ts: iso(5) },
  };
  const merchant_sig = await signer.sign(`merchant/${merchantId}`, claimSignaturePayload(base));
  const claim: ConversionClaim = { ...base, merchant_sig };

  // the adapter's intake event (SYN-6: ConversionClaimed is adapter-emitted)
  await appendEventInNewTx(pool, 'ConversionClaimed', {
    claim_id: claim.claim_id,
    merchant_id: merchantId,
    jti: minted.claims.jti,
    qid: minted.claims.qid,
    cid: minted.claims.cid,
    order_ref_hash: claim.order.order_ref_hash,
    gross_value: claim.order.gross_value,
    ts: claim.order.ts,
  });
  const verdict = await verifier.verify(claim, { idempotencyKey: claim.claim_id });
  if (verdict.verdict !== 'verified') throw new Error(`expected verified, got ${JSON.stringify(verdict)}`);

  // anchor: publish today's head AFTER the verdict landed
  const store = new FakeObjectStore(mkdtempSync(path.join(tmpdir(), 'merited-heads-')));
  const published = await publishHead(pool, store);
  if (!published.published) throw new Error('head publication failed');

  const { rows } = await pool.query<{
    seq: string;
    type: string;
    body: unknown;
    prev_hash: string;
    this_hash: string;
  }>(`SELECT seq, type, body, prev_hash, this_hash FROM events.events WHERE seq <= $1 ORDER BY seq`, [
    published.publication.seq,
  ]);

  const pack: ProofPack = {
    format: PROOF_PACK_FORMAT,
    heads: [published.publication],
    cor,
    claim,
    keys: {
      platform_mint_public_key: await spkiBase64('platform/mint'),
      platform_commitment_public_key: await spkiBase64('platform/commitments'),
      merchant_public_key: await spkiBase64(`merchant/${merchantId}`),
    },
    events: rows.map((row) => ({
      seq: Number(row.seq),
      type: row.type,
      body: row.body,
      prev_hash: row.prev_hash,
      this_hash: row.this_hash,
    })),
  };
  // gate evidence hook (PH3-10): export the real pack for the clean-container run
  if (process.env['MERITED_PACK_OUT']) writeFileSync(process.env['MERITED_PACK_OUT'], JSON.stringify(pack));
  return pack;
};

const clone = (pack: ProofPack): ProofPack => JSON.parse(JSON.stringify(pack));

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
  signer = new Ed25519Signer(new InMemoryKms(), new InMemoryKeyStore());
  const deps = { pool, signer, clock: systemClock };
  commitments = new CommitmentSimulator(deps);
  const keys = new MerchantKeySimulator(deps);
  mint = new MintSimulator(deps, commitments);
  verifier = new VerifySimulator(deps, new VerifiedDirectory(new FixtureDirectory(), signer), new InMemoryReplayCache());
  await keys.issueMerchantKey({ merchant_id: merchantId });
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('reference verifier (PH3-8 accept)', () => {
  it('GATE CLAUSE: a real conversion verifies OFFLINE from heads + COR + proof pack', async () => {
    const pack = buildPackCache ?? (buildPackCache = await buildPack());
    const result = await verifyProofPack(pack, trustFor(pack));
    expect(result).toMatchObject({ outcome: 'VERIFIED', claim_id: pack.claim.claim_id });
  });

  it('W12/#3: NO trusted anchor → INVALID (fail closed — the pack cannot self-certify)', async () => {
    const pack = buildPackCache ?? (buildPackCache = await buildPack());
    // an empty/absent anchor is refused before any pack check
    const noHeads = await verifyProofPack(pack, { heads: [], platform: trustFor(pack).platform });
    expect(noHeads).toMatchObject({ outcome: 'INVALID', step: 'pack' });
    // @ts-expect-error — deliberately calling without the required anchor
    const missing = await verifyProofPack(pack);
    expect(missing.outcome).toBe('INVALID');
  });

  it('W12/#3 FULL FORGERY: a self-consistent slice with its OWN head + attacker keys is INVALID', async () => {
    const pack = buildPackCache ?? (buildPackCache = await buildPack());
    const jcs = (v: unknown) => canonicalize(v);
    const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

    // The attacker rewrites the ledger, RE-CHAINS it so the slice is internally
    // consistent, points the pack's own `heads` at its forged tip, and swaps in
    // their own platform keys. Under the old verifier (anchor = pack.heads, sigs
    // = pack.keys) this self-certified as VERIFIED.
    const forged = clone(pack);
    (forged.events[0]!.body as { data: Record<string, unknown> }).data.forged = true;
    let prev = forged.events[0]!.prev_hash;
    for (const ev of forged.events) {
      ev.prev_hash = prev;
      ev.this_hash = sha(prev + jcs(ev.body));
      prev = ev.this_hash;
    }
    const tip = forged.events[forged.events.length - 1]!;
    forged.heads = [{ date: pack.heads[0]!.date, seq: tip.seq, head_hash: tip.this_hash }];
    const attacker = generateKeyPairSync('ed25519');
    const attackerSpki = (attacker.publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64');
    forged.keys = {
      platform_mint_public_key: attackerSpki,
      platform_commitment_public_key: attackerSpki,
      merchant_public_key: attackerSpki,
    };

    // Verified against the AUDITOR's out-of-band anchor (the REAL head + keys),
    // the forgery cannot anchor — its tip is not a trusted head.
    const result = await verifyProofPack(forged, trustFor(pack));
    expect(result).toMatchObject({ outcome: 'INVALID', step: 'chain' });
    expect((result as { detail: string }).detail).toContain('not anchored');
  });

  it('TAMPER: mutating ANY single event byte fails verification', async () => {
    const pack = buildPackCache ?? (buildPackCache = await buildPack());
    const trust = trustFor(pack);
    // flip one byte in EVERY event body in turn — each mutation must fail
    for (let i = 0; i < pack.events.length; i += 1) {
      const tampered = clone(pack);
      const body = tampered.events[i]!.body as { v: number };
      body.v = 2; // one changed byte in the hashed body
      const result = await verifyProofPack(tampered, trust);
      expect(result.outcome).toBe('INVALID');
      expect((result as { step: string }).step).toBe('chain');
    }
  });

  it('TAMPER: a forged claim amount fails the merchant signature', async () => {
    const pack = buildPackCache ?? (buildPackCache = await buildPack());
    const tampered = clone(pack);
    tampered.claim.order.gross_value.amount = 1; // £84.50 → 1p
    const result = await verifyProofPack(tampered, trustFor(pack));
    expect(result).toMatchObject({ outcome: 'INVALID', step: 'claim' });
  });

  it('TAMPER: swapped merchant key fails — pack-carried keys cannot forge anchored artefacts', async () => {
    const pack = buildPackCache ?? (buildPackCache = await buildPack());
    const tampered = clone(pack);
    tampered.keys.merchant_public_key = tampered.keys.platform_mint_public_key; // wrong key
    const result = await verifyProofPack(tampered, trustFor(pack));
    expect(result).toMatchObject({ outcome: 'INVALID', step: 'cor' });
  });

  it('the dev fake token format refuses STRUCTURALLY before any cryptography', async () => {
    const pack = buildPackCache ?? (buildPackCache = await buildPack());
    const tampered = clone(pack);
    tampered.claim.attribution_token = 'v4.public.fake.eyJqdGkiOiJ4In0.sig';
    const result = await verifyProofPack(tampered, trustFor(pack));
    expect(result).toMatchObject({ outcome: 'INVALID', step: 'token' });
    expect((result as { detail: string }).detail).toContain('dev formats');
  });

  it('a REJECTED conversion reports the ledger reason (replayed token)', async () => {
    const pack = buildPackCache ?? (buildPackCache = await buildPack());
    // replay the SAME token under a new claim — the trio rejects, the ledger records it
    const base = {
      claim_id: ids.next('clm'),
      merchant_id: merchantId,
      attribution_token: pack.claim.attribution_token,
      order: { order_ref_hash: 'e'.repeat(64), gross_value: pence(8450), ts: iso(6) },
    };
    const merchant_sig = await signer.sign(`merchant/${merchantId}`, claimSignaturePayload(base));
    const replayClaim: ConversionClaim = { ...base, merchant_sig };
    // the token's claims, read from the pack's own anchored TokenMinted event
    const mintRow = pack.events.find((row) => row.type === 'TokenMinted')!;
    const mc = ((mintRow.body as { data: { claims: { jti: string; qid: string; cid: string } } }).data).claims;
    await appendEventInNewTx(pool, 'ConversionClaimed', {
      claim_id: replayClaim.claim_id,
      merchant_id: merchantId,
      jti: mc.jti,
      qid: mc.qid,
      cid: mc.cid,
      order_ref_hash: replayClaim.order.order_ref_hash,
      gross_value: replayClaim.order.gross_value,
      ts: replayClaim.order.ts,
    });
    const verdict = await verifier.verify(replayClaim, { idempotencyKey: replayClaim.claim_id });
    expect(verdict).toMatchObject({ verdict: 'rejected', reason_code: 'TOKEN_REPLAYED' });

    const store = new FakeObjectStore(mkdtempSync(path.join(tmpdir(), 'merited-heads-')));
    const published = await publishHead(pool, store, { date: '2099-01-01' });
    if (!published.published) throw new Error('head publication failed');
    const { rows } = await pool.query<{
      seq: string;
      type: string;
      body: unknown;
      prev_hash: string;
      this_hash: string;
    }>(`SELECT seq, type, body, prev_hash, this_hash FROM events.events WHERE seq <= $1 ORDER BY seq`, [
      published.publication.seq,
    ]);
    const rejectedPack: ProofPack = {
      ...clone(pack),
      heads: [published.publication],
      claim: replayClaim,
      events: rows.map((row) => ({
        seq: Number(row.seq),
        type: row.type,
        body: row.body,
        prev_hash: row.prev_hash,
        this_hash: row.this_hash,
      })),
    };
    const result = await verifyProofPack(rejectedPack, trustFor(rejectedPack));
    expect(result).toMatchObject({
      outcome: 'REJECTED',
      claim_id: replayClaim.claim_id,
      reason_code: 'TOKEN_REPLAYED',
    });
  });

  it('CLI: `merited-verify <pack> --trust <anchor>` exits 0 and prints VERIFIED', async () => {
    const pack = buildPackCache ?? (buildPackCache = await buildPack());
    const dir = mkdtempSync(path.join(tmpdir(), 'merited-pack-'));
    const packPath = path.join(dir, 'pack.json');
    const trustPath = path.join(dir, 'trust.json');
    writeFileSync(packPath, JSON.stringify(pack));
    writeFileSync(trustPath, JSON.stringify(trustFor(pack)));
    const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/cli.js');
    const run = spawnSync('node', [cliPath, packPath, '--trust', trustPath], { encoding: 'utf-8' });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('"VERIFIED"');

    // and WITHOUT the trust anchor the CLI refuses (usage error, exit 1)
    const noTrust = spawnSync('node', [cliPath, packPath], { encoding: 'utf-8' });
    expect(noTrust.status).toBe(1);
  });
});

let buildPackCache: ProofPack | null = null;
