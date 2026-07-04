import { MECHANICS_FIXTURES, newId, Offer, type OfferMechanics } from '@merited/contracts';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../scripts/migrate.mjs';
import { OffersRepository } from './repository.js';
import { OffersService } from './service.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_off_${Date.now().toString(36)}`;

let admin: pg.Client;
let pool: pg.Pool;
let repository: OffersRepository;
let service: OffersService;

const draftInput = (mechanics: OfferMechanics, index = 0) => ({
  merchant_id: newId('mer'),
  title: `Aurora offer ${index}`,
  description: 'Spa day with all the trimmings.',
  mechanics,
  sku_scope: index % 2 === 0 ? ('all' as const) : ['sku_spa_day', 'sku_lunch'],
  identity_tiers: ['T1', 'T2', 'T3'] as ('T1' | 'T2' | 'T3')[],
  stacking_group: index % 3 === 0 ? null : 'aurora-summer',
  valid_from: '2026-07-01T00:00:00Z',
  valid_until: '2026-12-31T23:59:59Z',
});

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  await migrateCore(`postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 10,
  });
  pool.on('error', () => {});
  repository = new OffersRepository(drizzle(pool));
  service = new OffersService(repository);
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('offers storage (CORE-2 accept, §5.1 verbatim)', () => {
  it('all 27 mechanics round-trip through Zod: insert → select → Offer.parse → deep-equal', async () => {
    expect(MECHANICS_FIXTURES).toHaveLength(27);
    for (const [index, mechanics] of MECHANICS_FIXTURES.entries()) {
      const created = await service.createDraft(draftInput(mechanics, index));
      const readBack = await service.get(created.offer_id);
      expect(Offer.parse(readBack)).toEqual(created);
      expect(readBack.mechanics).toEqual(mechanics);
    }
  });

  it('the write boundary rejects mechanics outside the union', async () => {
    await expect(
      service.createDraft(
        draftInput({ type: 'infinite_money_glitch', pct_bps: 10000 } as never),
      ),
    ).rejects.toThrow();
    await expect(
      // right discriminant, wrong field shape: floats are not pence
      service.createDraft(draftInput({ type: 'fixed_off', value: { amount: 4.99, currency: 'GBP_pence' } } as never)),
    ).rejects.toThrow();
  });

  it('lifecycle: draft → (publish elsewhere) live → paused; end is terminal; ended is uneditable', async () => {
    const offer = await service.createDraft(draftInput(MECHANICS_FIXTURES[0]!));
    expect(offer.status).toBe('draft');

    // pause requires live (publishing arrives with CORE-5 — simulate via the repo primitive)
    await expect(service.pause(offer.offer_id)).rejects.toMatchObject({ code: 'OFFER_NOT_LIVE' });
    expect(await repository.setStatus(offer.offer_id, 'live', ['draft'])).toBe(true);
    await service.pause(offer.offer_id);
    expect((await service.get(offer.offer_id)).status).toBe('paused');

    await service.end(offer.offer_id);
    expect((await service.get(offer.offer_id)).status).toBe('ended');
    await expect(service.end(offer.offer_id)).rejects.toMatchObject({ code: 'OFFER_ENDED' });
    await expect(service.update(offer.offer_id, { title: 'zombie edit' })).rejects.toMatchObject({
      code: 'OFFER_ENDED',
    });
  });

  it('update edits a draft in place and re-validates mechanics', async () => {
    const offer = await service.createDraft(draftInput(MECHANICS_FIXTURES[1]!));
    const updated = await service.update(offer.offer_id, {
      title: 'Renamed',
      mechanics: { type: 'percentage_off', pct_bps: 2500 },
    });
    expect(updated.title).toBe('Renamed');
    const readBack = await service.get(offer.offer_id);
    expect(readBack.mechanics).toEqual({ type: 'percentage_off', pct_bps: 2500 });
    await expect(
      service.update(offer.offer_id, { mechanics: { type: 'bogo' } as never }),
    ).rejects.toThrow();
  });

  it('list filters by merchant and status; get 404s on unknown ids', async () => {
    const merchantId = newId('mer');
    const first = await service.createDraft({ ...draftInput(MECHANICS_FIXTURES[2]!), merchant_id: merchantId });
    await service.createDraft({ ...draftInput(MECHANICS_FIXTURES[3]!), merchant_id: merchantId });
    const mine = await service.list({ merchantId });
    expect(mine).toHaveLength(2);
    expect(await repository.setStatus(first.offer_id, 'live', ['draft'])).toBe(true);
    expect(await service.list({ merchantId, status: 'live' })).toHaveLength(1);
    await expect(service.get(newId('off'))).rejects.toMatchObject({ code: 'OFFER_NOT_FOUND' });
  });

  it('counters start at zero and live outside the offer row (read-model, §5.1)', async () => {
    const offer = await service.createDraft(draftInput(MECHANICS_FIXTURES[4]!));
    expect(await repository.redeemCount(offer.offer_id)).toBe(0);
    expect(await repository.commitmentHistory(offer.offer_id)).toEqual([]);
  });
});
