import { createSimulatedCore, type SimulatedCore } from '@merited/core/testing';
import { createFakeShop } from '@merited/fake-aurora';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../core/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../trio/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateValet } from '../scripts/migrate.mjs';
import { runSeed } from '../../../tools/seed/src/seed.js';
import { AURORA_MEMBERS } from '../../../tools/seed/src/fixtures/aurora.js';
import { buildCliDeps, runCli } from '../src/cli.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_cli_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'cli-test';
const SIGNER_SECRET = 'trio-test-secret';

let admin: pg.Client;
let trio: SimulatedTrio;
let core: SimulatedCore;
let shop: FastifyInstance;
let deps: ReturnType<typeof buildCliDeps>;
let lines: string[] = [];

const gold = AURORA_MEMBERS.find((m) => m.loyalty_tier === 'Gold' && m.status === 'active')!;

/** Volatile-field normalisation: IDs, hashes, tokens and timestamps become
 * stable placeholders; everything else must be byte-identical run to run. */
const normalise = (line: string): string =>
  line
    .replace(/\b(ern|qte|off|com|agt|atk|clm|mer|usr|apr|evt|set)_[0-9A-Za-z_-]+/g, '<$1>')
    .replace(/\b[0-9a-f]{64}\b/g, '<hash>')
    .replace(/v4\.public\.fake\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '<token>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, '<timestamp>');

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  await migrateTrio(adminUrl);
  await migrateValet(adminUrl);
  const appUrl = `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`;

  await runSeed({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signerSecret: SIGNER_SECRET, log: () => {} });

  trio = createSimulatedTrio({ databaseUrl: appUrl, serviceToken: SERVICE_TOKEN, signerSecret: SIGNER_SECRET });
  const trioUrl = await trio.listen();
  core = createSimulatedCore({
    databaseUrl: appUrl,
    trioBaseUrl: trioUrl,
    trioServiceToken: SERVICE_TOKEN,
    signerSecret: SIGNER_SECRET,
  });
  const coreUrl = await core.listen();
  const merchant = (await core.merchants.list())[0]!;
  const webhookSecret = (await core.merchants.issueWebhookSecret(merchant.merchant_id)).secret;
  shop = createFakeShop({
    shopDomain: 'aurora.fakeshop.test',
    adapterUrl: `${coreUrl}/v1/merchants/${merchant.slug}/webhooks/order-confirmed`,
    webhookSecret,
  });
  const shopUrl = await shop.listen({ port: 0, host: '127.0.0.1' });

  deps = buildCliDeps(
    { coreUrl, shopUrl, databaseUrl: appUrl, valetDatabaseUrl: `postgres://merited_valet:merited_valet_dev@localhost:5432/${dbName}` },
    (line) => lines.push(line),
  );
});

afterAll(async () => {
  await deps.close();
  await shop.close();
  await core.close();
  await trio.close();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('valet CLI (VAL-7 accept — B18 end-to-end with snapshot output)', () => {
  it('brief → quote → checkout → verdict → settlement lines, snapshot with volatile fields normalised', async () => {
    lines = [];
    const code = await runCli(
      ['brief', 'spa day under £120', '--sub-hash', gold.sub_hash, '--max-pence', '12000'],
      deps,
    );
    expect(code).toBe(0);
    const output = lines.map(normalise);
    // the D7 pennies, verbatim in the printout
    expect(output).toContain('  merchant −£12.00');
    expect(output).toContain('  agent    +£7.20');
    expect(output).toContain('  Merited  +£2.40');
    expect(output).toContain('  reserve  £2.40');
    expect(output.join('\n')).toMatchSnapshot();
  });

  it('status re-reads a finished errand: state, quote, decoded claims, verdict', async () => {
    lines = [];
    await runCli(['brief', 'sunrise yoga classes', '--max-pence', '10000'], deps);
    // yoga offer carries no bounty → no payable quote → the errand fails the search
    const failedLine = lines.find((l) => l.startsWith('Errand finished'));
    expect(failedLine).toBe('Errand finished in state FAILED.');

    const open = await deps.store.loadOpenErrands();
    const failed = open.find((s) => s.state === 'FAILED')!;
    lines = [];
    const code = await runCli(['status', failed.errand.errand_id], deps);
    expect(code).toBe(0);
    expect(lines[0]).toBe(`Errand ${failed.errand.errand_id}: FAILED`);
  });

  it('resume on a CONFIRMED errand is a quiet no-op with the verdict reprinted', async () => {
    lines = [];
    await runCli(['brief', 'full spa day', '--sub-hash', gold.sub_hash], deps);
    const briefLine = lines[0]!;
    const errandId = /Errand (ern_[0-9A-Z]+)/.exec(briefLine)![1]!;
    expect(lines.find((l) => l.startsWith('Errand finished'))).toBe('Errand finished in state CONFIRMED.');

    lines = [];
    const code = await runCli(['resume', errandId], deps);
    expect(code).toBe(0);
    expect(lines.some((l) => l.startsWith('Verdict: verified'))).toBe(true);
    expect(lines.filter((l) => l.includes('→'))).toHaveLength(0); // no re-transitions
  });

  it('usage errors are helpful and exit 1', async () => {
    lines = [];
    expect(await runCli(['brief'], deps)).toBe(1);
    expect(lines[0]).toContain('Usage: valet brief');
    lines = [];
    expect(await runCli([], deps)).toBe(1);
    expect(lines[0]).toContain('Usage: valet');
  });
});
