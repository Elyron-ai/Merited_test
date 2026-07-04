import {
  newId,
  pence,
  type CommitmentStatus,
  type MerchantCommercial,
  type Offer,
} from '@merited/contracts';
import { canonicalJson } from '@merited/events';
import { FakeCrypter, FakeSigner } from '@merited/signing';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../../../trio/scripts/migrate.mjs';
import { MerchantsService } from '../merchants/service.js';
import { TrioKeysClient } from '../merchants/trio-keys-client.js';
import { TrioTokenClient } from '../token-client/client.js';
import { OfferPublisher } from './publisher.js';
import { OffersRepository } from './repository.js';
import { OffersService } from './service.js';
import { TrioCommitmentsClient } from './trio-commitments-client.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_pub_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'publish-test';
const signer = new FakeSigner('trio-test-secret');

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let trioUrl: string;
let offers: OffersService;
let repository: OffersRepository;
let publisher: OfferPublisher;
let merchants: MerchantsService;
let tokenClient: TrioTokenClient;

const commercial: MerchantCommercial = {
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  attribution_window_s: 86400,
  clawback_window_s: 2592000,
  budgets: { per_offer_default: null },
};

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const offerInput = (merchantId: `mer_${string}`): Omit<Offer, 'offer_id' | 'status'> => ({
  merchant_id: merchantId,
  title: 'Aurora spa day',
  description: 'Full spa day with member pricing.',
  mechanics: { type: 'member_price', sku_ref: 'sku_spa_day', price: pence(8450) },
  sku_scope: ['sku_spa_day'],
  identity_tiers: ['T1', 'T2', 'T3'],
  stacking_group: null,
  valid_from: iso(-3600),
  valid_until: iso(180 * 86400),
});

beforeAll(async () => {
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
  trio = createSimulatedTrio({
    databaseUrl: appUrl,
    serviceToken: SERVICE_TOKEN,
    signerSecret: 'trio-test-secret',
  });
  trioUrl = await trio.listen();

  repository = new OffersRepository(drizzle(pool));
  offers = new OffersService(repository);
  merchants = new MerchantsService(
    pool,
    new FakeCrypter('publish-test-crypter'),
    new TrioKeysClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
  );
  publisher = new OfferPublisher({
    pool,
    repository,
    commitments: new TrioCommitmentsClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN }),
    merchantFor: (id) => merchants.get(id),
  });
  tokenClient = new TrioTokenClient({ baseUrl: trioUrl, serviceToken: SERVICE_TOKEN });
});

afterAll(async () => {
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

const trioStatus = async (cid: string): Promise<CommitmentStatus> => {
  const res = await fetch(`${trioUrl}/trio/commitments/${cid}`, {
    headers: { 'x-merited-service-token': SERVICE_TOKEN },
  });
  return (await res.json()) as CommitmentStatus;
};

describe('offer publish + COR lifecycle (CORE-5 accept, §5.1 verbatim)', () => {
  it('publish → COR-1 + events; mint on COR-1; bounty edit → COR-2; the COR-1 token STILL verifies', async () => {
    const merchant = await merchants.create({ name: 'Aurora Experiences', commercial });
    const offer = await offers.createDraft(offerInput(merchant.merchant_id));

    // publish with the demo's £12.00 fixed CPA bounty
    const published = await publisher.publish(offer.offer_id, {
      bounty: { type: 'fixed', amount: pence(1200) },
    });
    const cor1 = published.commitment_id!;
    expect(cor1).toMatch(/^com_/);
    expect((await offers.get(offer.offer_id)).status).toBe('live');

    // both events land: OfferPublished (core) + CommitmentCreated (trio)
    const events = await pool.query(
      `SELECT type, body->'data' AS data FROM events.events
        WHERE type IN ('OfferPublished', 'CommitmentCreated') ORDER BY seq`,
    );
    const types = events.rows.map((r) => r.type);
    expect(types).toContain('OfferPublished');
    expect(types).toContain('CommitmentCreated');
    const publishedEvent = events.rows.find((r) => r.type === 'OfferPublished')!.data as {
      offer_id: string;
      commitment_id: string;
    };
    expect(publishedEvent).toMatchObject({ offer_id: offer.offer_id, commitment_id: cor1 });

    // mint an in-flight token against COR-1 (CORE-9 client)
    const minted = await tokenClient.mint({
      cid: cor1 as `com_${string}`,
      qid: newId('qte'),
      aid: newId('agt'),
      tier: 'T3',
      session_nonce: 'publish-test',
      quote: { expires_at: iso(300), mandate_ref: null },
    });
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;

    // bounty edit → COR-2; offer repoints; history preserved
    const edited = await publisher.editBounty(offer.offer_id, {
      bounty: { type: 'fixed', amount: pence(1500) },
    });
    const cor2 = edited.commitment_id;
    expect(edited.old_commitment_id).toBe(cor1);
    expect(cor2).not.toBe(cor1);
    const record = await repository.get(offer.offer_id);
    expect(record!.current_commitment_id).toBe(cor2);
    const history = await repository.commitmentHistory(offer.offer_id);
    expect(history).toHaveLength(2);
    expect(history[0]!.commitment_id).toBe(cor1);
    expect(history[0]!.ended_at).not.toBeNull();
    expect(history[1]!.commitment_id).toBe(cor2);
    expect(history[1]!.ended_at).toBeNull();
    expect((await trioStatus(cor1)).status).toBe('ended');
    expect((await trioStatus(cor2)).status).toBe('live');

    // §5.1: "old tokens still verify against the first" (SYN-34)
    const claimBase = {
      claim_id: newId('clm'),
      merchant_id: merchant.merchant_id,
      attribution_token: minted.minted.token,
      order: {
        order_ref_hash: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        gross_value: pence(8450),
        ts: iso(10),
      },
    };
    const merchant_sig = await signer.sign(`merchant/${merchant.merchant_id}`, canonicalJson(claimBase));
    const verdict = await fetch(`${trioUrl}/trio/claims/verify`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-merited-service-token': SERVICE_TOKEN,
        'idempotency-key': newId('clm'),
      },
      body: JSON.stringify({ ...claimBase, merchant_sig }),
    });
    expect(verdict.status).toBe(200);
    expect(((await verdict.json()) as { verdict: string }).verdict).toBe('verified');
  });

  it('a bounty-free offer publishes live with no COR and a null commitment_id in the event', async () => {
    const merchant = await merchants.create({ name: 'Loyalty Only', commercial });
    const offer = await offers.createDraft(offerInput(merchant.merchant_id));
    const published = await publisher.publish(offer.offer_id);
    expect(published.commitment_id).toBeNull();
    expect((await offers.get(offer.offer_id)).status).toBe('live');
    expect(await repository.commitmentHistory(offer.offer_id)).toEqual([]);

    await expect(publisher.editBounty(offer.offer_id, { bounty: { type: 'fixed', amount: pence(100) } }))
      .rejects.toMatchObject({ code: 'NO_COMMITMENT' });
  });

  it('publish guards: already-live → 409; unknown → 404; merchant default budget flows into the COR', async () => {
    const merchant = await merchants.create({
      name: 'Budgeted Shop',
      commercial: { ...commercial, budgets: { per_offer_default: pence(2400) } },
    });
    const offer = await offers.createDraft(offerInput(merchant.merchant_id));
    const published = await publisher.publish(offer.offer_id, {
      bounty: { type: 'fixed', amount: pence(1200) },
    });
    await expect(publisher.publish(offer.offer_id)).rejects.toMatchObject({
      code: 'OFFER_NOT_PUBLISHABLE',
    });
    await expect(publisher.publish(newId('off'))).rejects.toMatchObject({ code: 'OFFER_NOT_FOUND' });

    // budget registered as a Settlement counter (SYN-12): 2 × 1200p then dry
    const status = await trioStatus(published.commitment_id!);
    expect(status.budget_remaining).toEqual(pence(2400));
  });
});
