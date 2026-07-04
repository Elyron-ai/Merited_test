import { createServer, type Server } from 'node:http';
import { newId, pence, type CommitmentDraft } from '@merited/contracts';
import { activeTraceId, initOtel, shutdownOtel, withSpan } from '@merited/otel';
import { createSimulatedTrio, type SimulatedTrio } from '@merited/trio/testing';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateTrio } from '../../../../trio/scripts/migrate.mjs';
import { TrioTokenClient } from './client.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_tkc_${Date.now().toString(36)}`;
const SERVICE_TOKEN = 'token-client-test';

let admin: pg.Client;
let trio: SimulatedTrio;
let baseUrl: string;
let client: TrioTokenClient;

const draft = (overrides: Partial<CommitmentDraft['terms']> = {}): CommitmentDraft => ({
  merchant_id: newId('mer'),
  offer_ref: newId('off'),
  bounty: { type: 'fixed', amount: pence(1200) },
  take_rate_bps: 2000,
  agent_commission_bps: 6000,
  terms: {
    attribution_window_s: 86400,
    eligible_identity_tiers: ['T1', 'T2', 'T3'],
    max_conversions: 500,
    clawback_window_s: 2592000,
    valid_from: new Date(Date.now() - 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    valid_until: new Date(Date.now() + 90 * 86400_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    ...overrides,
  },
});

const iso = (offsetS: number): string =>
  new Date(Date.now() + offsetS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');

const createCommitment = async (): Promise<`com_${string}`> => {
  const response = await fetch(`${baseUrl}/trio/commitments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-merited-service-token': SERVICE_TOKEN },
    body: JSON.stringify(draft()),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { commitment: { commitment_id: `com_${string}` } };
  return body.commitment.commitment_id;
};

const mintInput = (cid: string, overrides: Record<string, unknown> = {}) => ({
  cid: cid as `com_${string}`,
  qid: newId('qte'),
  aid: newId('agt'),
  tier: 'T3' as const,
  session_nonce: 'core-token-client',
  quote: { expires_at: iso(300), mandate_ref: null },
  ...overrides,
});

beforeAll(async () => {
  initOtel({ serviceName: 'token-client-test', exporter: 'memory' });
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateTrio(adminUrl);
  trio = createSimulatedTrio({
    databaseUrl: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    serviceToken: SERVICE_TOKEN,
    signerSecret: 'trio-test-secret',
  });
  baseUrl = await trio.listen();
  client = new TrioTokenClient({ baseUrl, serviceToken: SERVICE_TOKEN });
});

afterAll(async () => {
  await trio.close();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
  await shutdownOtel();
});

describe('token-client against the trio simulator (CORE-9 accept)', () => {
  it('minted claims echo cid/qid/aid/tier; exp > iat; fresh jti per call', async () => {
    const cid = await createCommitment();
    const input = mintInput(cid);
    const first = await client.mint(input);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.minted.claims.cid).toBe(cid);
    expect(first.minted.claims.qid).toBe(input.qid);
    expect(first.minted.claims.aid).toBe(input.aid);
    expect(first.minted.claims.tier).toBe('T3');
    expect(first.minted.claims.exp).toBeGreaterThan(first.minted.claims.iat);
    expect(typeof first.minted.token).toBe('string');

    const second = await client.mint(mintInput(cid));
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.minted.claims.jti).not.toBe(first.minted.claims.jti);
  });

  it('re-mint with apr set: same qid, fresh jti (B26 path, live against the sim)', async () => {
    const cid = await createCommitment();
    const qid = newId('qte');
    const original = await client.mint(mintInput(cid, { qid }));
    const reminted = await client.mint(mintInput(cid, { qid, apr: newId('apr') }));
    expect(original.ok && reminted.ok).toBe(true);
    if (!original.ok || !reminted.ok) return;
    expect(reminted.minted.claims.qid).toBe(original.minted.claims.qid);
    expect(reminted.minted.claims.jti).not.toBe(original.minted.claims.jti);
    expect(reminted.minted.claims.apr).not.toBeNull();
  });

  it('trio error bodies map to typed failures — never a throw', async () => {
    const unknown = await client.mint(mintInput(newId('com')));
    expect(unknown).toEqual({
      ok: false,
      error: { code: 'COMMITMENT_NOT_FOUND', message: 'trio responded 404' },
    });

    const cid = await createCommitment();
    await fetch(`${baseUrl}/trio/commitments/${cid}/end`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-merited-service-token': SERVICE_TOKEN },
      body: JSON.stringify({}),
    });
    const ended = await client.mint(mintInput(cid));
    expect(ended.ok).toBe(false);
    if (!ended.ok) expect(ended.error.code).toBe('COMMITMENT_NOT_LIVE');

    const overlongQuote = await client.mint(
      mintInput(await createCommitment(), { quote: { expires_at: iso(3600), mandate_ref: null } }),
    );
    expect(overlongQuote.ok).toBe(false);
    if (!overlongQuote.ok) expect(overlongQuote.error.code).toBe('QUOTE_EXPIRY_EXCEEDS_TOKEN');

    const badAuth = new TrioTokenClient({ baseUrl, serviceToken: 'wrong' });
    const denied = await badAuth.mint(mintInput(cid));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe('SERVICE_AUTH_FAILED');
  });

  it('timeout and network failures return typed errors within the 2s budget', async () => {
    // a server that never responds
    const stall: Server = createServer(() => {});
    await new Promise<void>((resolve) => stall.listen(0, '127.0.0.1', resolve));
    const port = (stall.address() as { port: number }).port;
    const stallClient = new TrioTokenClient({
      baseUrl: `http://127.0.0.1:${port}`,
      serviceToken: SERVICE_TOKEN,
      timeoutMs: 200,
    });
    const timedOut = await stallClient.mint(mintInput(newId('com')));
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) expect(timedOut.error.code).toBe('TIMEOUT');
    stall.close();

    const refused = new TrioTokenClient({
      baseUrl: 'http://127.0.0.1:9', // discard port — connection refused
      serviceToken: SERVICE_TOKEN,
      timeoutMs: 500,
    });
    const failed = await refused.mint(mintInput(newId('com')));
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(['NETWORK_ERROR', 'TIMEOUT']).toContain(failed.error.code);
  });

  it('propagates the active span as a W3C traceparent header (§8 one-trace)', async () => {
    const seen: string[] = [];
    const spy: Server = createServer((req, res) => {
      seen.push(String(req.headers['traceparent'] ?? ''));
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'COMMITMENT_NOT_FOUND' } }));
    });
    await new Promise<void>((resolve) => spy.listen(0, '127.0.0.1', resolve));
    const port = (spy.address() as { port: number }).port;
    const spyClient = new TrioTokenClient({
      baseUrl: `http://127.0.0.1:${port}`,
      serviceToken: SERVICE_TOKEN,
    });

    let traceId: string | null = null;
    await withSpan('token-client-test-span', async () => {
      traceId = activeTraceId();
      await spyClient.mint(mintInput(newId('com')));
    });
    expect(traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(new RegExp(`^00-${traceId}-[0-9a-f]{16}-0[01]$`));
    spy.close();
  });
});
