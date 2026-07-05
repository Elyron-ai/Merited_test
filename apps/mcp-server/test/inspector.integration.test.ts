import { createSimulatedCore, type SimulatedCore } from '@merited/core/testing';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import { MeritedClient } from '@merited/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../core/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../trio/scripts/migrate.mjs';
import { runSeed } from '../../../tools/seed/src/seed.js';
import { AURORA_OFFERS } from '../../../tools/seed/src/fixtures/aurora.js';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildMcpServer } from '../src/server.js';

/**
 * PH1-6 gate — "MCP server passes inspector". We drive the server through
 * the MCP protocol itself (the inspector's own client + an in-memory
 * transport pair), against a REAL Core + trio with the Aurora seed: schema
 * validation, the happy path for all three tools, and an ineligible-offer
 * case surfacing the exclusion reason.
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_mcp_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'mcp-test-service';
const SIGNER_SECRET = 'trio-test-secret';

let admin: pg.Client;
let pool: pg.Pool;
let trio: SimulatedTrio;
let core: SimulatedCore;
let client: Client;

const spaOffer = AURORA_OFFERS.find((o) => o.offer_id.includes('SPADAY'))!.offer_id;
const thresholdT1Only = AURORA_OFFERS.find((o) => o.offer_id.includes('THRESH'))!.offer_id;

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

  // the MCP server acts as an ORDINARY registered agent (P5)
  const bootstrap = new MeritedClient({ baseUrl: coreUrl });
  const { api_key } = await bootstrap.register({ name: 'MCP Agent', contact: 'mcp@merited.test' });

  const server = buildMcpServer({ baseUrl: coreUrl, agentApiKey: api_key });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: 'inspector', version: '1.0.0' });
  await client.connect(clientTransport);
}, 120_000);

afterAll(async () => {
  await client.close();
  await core.close();
  await trio.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

const parse = (result: { content: Array<{ type: string; text?: string }> }) =>
  JSON.parse(result.content.find((c) => c.type === 'text')!.text!);

describe('MCP inspector gate (PH1-6)', () => {
  it('lists exactly the three tools with generated JSON Schemas', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'check_eligibility',
      'get_offer',
      'search_offers',
    ]);
    // schema is generated from the contracts Zod shape (single source)
    const search = tools.find((t) => t.name === 'search_offers')!;
    expect(search.inputSchema.type).toBe('object');
    expect(Object.keys(search.inputSchema.properties ?? {})).toContain('text');
  });

  it('search_offers happy path: tokenised quotes for a registered agent (P2)', async () => {
    const result = await client.callTool({ name: 'search_offers', arguments: { text: 'spa' } });
    const payload = parse(result as never);
    expect(Array.isArray(payload.quotes)).toBe(true);
    expect(payload.quotes.length).toBeGreaterThan(0);
    // every payable read mints — a registered agent's quotes carry tokens
    expect(payload.quotes.every((q: { token: string | null }) => q.token !== null)).toBe(true);
  });

  it('get_offer happy path: a fresh tokenised quote for the spa offer', async () => {
    const result = await client.callTool({ name: 'get_offer', arguments: { offer_id: spaOffer } });
    const payload = parse(result as never);
    expect(payload.quote.offer_id).toBe(spaOffer);
    expect(payload.quote.token).not.toBeNull();
  });

  it('check_eligibility: verdicts only (no token), and an ineligible offer surfaces its reason', async () => {
    // anonymous consumer signals → T3; the threshold offer is T1-only
    const result = await client.callTool({
      name: 'check_eligibility',
      arguments: { offer_ids: [spaOffer, thresholdT1Only] },
    });
    const payload = parse(result as never);
    expect(JSON.stringify(payload)).not.toMatch(/token|quote_id/); // SYN-26: nothing payable
    const byId = new Map(payload.results.map((r: { offer_id: string }) => [r.offer_id, r]));
    expect((byId.get(spaOffer) as { eligible: boolean }).eligible).toBe(true);
    const threshold = byId.get(thresholdT1Only) as { eligible: boolean; reason?: string };
    expect(threshold.eligible).toBe(false);
    expect(threshold.reason).toBe('TIER_INELIGIBLE');
  });

  it('schema validation: a malformed tool call is rejected at the schema, not executed', async () => {
    const result = (await client.callTool({
      name: 'check_eligibility',
      arguments: { offer_ids: 'not-an-array' },
    })) as { isError?: boolean; content: Array<{ text?: string }> };
    // the generated JSON Schema refuses the call before the handler runs
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/validation|invalid/i);
  });
});
