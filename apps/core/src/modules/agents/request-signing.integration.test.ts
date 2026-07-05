import { AgentRequestSigner, generateAgentKeypair } from '@merited/sdk';
import { FakeSigner } from '@merited/signing';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../scripts/migrate.mjs';
import Fastify, { type FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryRateLimiter } from '../adapters/rate-limiter/index.js';
import { registerAgentAuth } from './auth.js';
import { AgentRequestVerifier } from './request-signing.js';
import { AgentsService } from './service.js';

/**
 * PH1-5 accept, end-to-end over HTTP: SDK-signed requests verify; tampered
 * body/path/ts → 401; replayed nonce → 401; the Phase-0 tiers (API-key
 * fallback, anonymous degraded read) still hold.
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_reqsign_${Date.now().toString(36)}`;

let admin: pg.Client;
let pool: pg.Pool;
let app: FastifyInstance;
let baseUrl: string;
let signer: AgentRequestSigner;
let agentId: `agt_${string}`;
let apiKey: string;

class InMemoryReplay {
  private readonly keys = new Set<string>();
  async seenBefore(key: string): Promise<boolean> {
    if (this.keys.has(key)) return true;
    this.keys.add(key);
    return false;
  }
  async peek(key: string): Promise<boolean> {
    return this.keys.has(key);
  }
}

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl);
  await migrateCore(adminUrl);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 5,
  });
  pool.on('error', () => {});

  const agents = new AgentsService(pool);
  const keypair = generateAgentKeypair();
  const registered = await agents.register({
    name: 'Signed Valet',
    contact: 'valet@merited.test',
    public_key: keypair.publicKey,
  });
  agentId = registered.agent_id;
  apiKey = registered.api_key;
  signer = new AgentRequestSigner(agentId, keypair.privateKeyPkcs8);

  const verifier = new AgentRequestVerifier({
    pool,
    replayCache: new InMemoryReplay(),
    clock: { now: () => new Date() },
    fakeSigner: new FakeSigner('reqsign-dev'),
  });
  app = Fastify();
  registerAgentAuth(app, {
    authenticate: (key) => agents.authenticate(key),
    limiter: new InMemoryRateLimiter({ limit: 1000, windowS: 60 }),
    requestVerifier: verifier,
  });
  app.post('/v1/echo', async (req) => ({ agent_id: req.agentCtx.agent_id }));
  app.get('/v1/echo', async (req) => ({ agent_id: req.agentCtx.agent_id }));
  app.setErrorHandler((error, _req, reply) =>
    reply.code((error as { statusCode?: number }).statusCode ?? 500).send({ code: (error as { code?: string }).code }),
  );
  baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

const post = (body: string, headers: Record<string, string>) =>
  fetch(`${baseUrl}/v1/echo`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });

describe('agent request signing (PH1-5)', () => {
  it('an SDK-signed request verifies end-to-end and authenticates the agent', async () => {
    const body = JSON.stringify({ q: 'spa day' });
    const response = await post(body, signer.headersFor({ method: 'POST', pathWithQuery: '/v1/echo', body }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ agent_id: agentId });
  });

  it('tampered body, path and timestamp each → 401 (fail closed, never fall through)', async () => {
    const body = JSON.stringify({ q: 'spa day' });
    const headers = signer.headersFor({ method: 'POST', pathWithQuery: '/v1/echo', body });
    // body tamper
    expect((await post(JSON.stringify({ q: 'spa day', extra: 1 }), headers)).status).toBe(401);
    // path tamper: signed for a different path
    const wrongPath = signer.headersFor({ method: 'POST', pathWithQuery: '/v1/other', body });
    expect((await post(body, wrongPath)).status).toBe(401);
    // timestamp tamper: shift the signed ts after signing
    const shifted = { ...signer.headersFor({ method: 'POST', pathWithQuery: '/v1/echo', body }) };
    shifted['x-merited-timestamp'] = String(Number(shifted['x-merited-timestamp']) + 1);
    expect((await post(body, shifted)).status).toBe(401);
    // stale timestamp beyond the ±300s window
    const staleSigner = new AgentRequestSigner(
      agentId,
      generateAgentKeypair().privateKeyPkcs8,
      { now: () => new Date(Date.now() - 400_000) },
    );
    expect(
      (await post(body, staleSigner.headersFor({ method: 'POST', pathWithQuery: '/v1/echo', body }))).status,
    ).toBe(401);
  });

  it('a replayed nonce → 401; each fresh signature carries a fresh nonce', async () => {
    const body = '';
    const headers = signer.headersFor({ method: 'GET', pathWithQuery: '/v1/echo', body });
    const first = await fetch(`${baseUrl}/v1/echo`, { headers });
    expect(first.status).toBe(200);
    const replay = await fetch(`${baseUrl}/v1/echo`, { headers });
    expect(replay.status).toBe(401);
    // a new signature (fresh nonce) sails through
    const again = await fetch(`${baseUrl}/v1/echo`, {
      headers: signer.headersFor({ method: 'GET', pathWithQuery: '/v1/echo', body }),
    });
    expect(again.status).toBe(200);
  });

  it('an unregistered key never verifies — and never enrols', async () => {
    const stranger = new AgentRequestSigner(
      'agt_00000000000000000000000009',
      generateAgentKeypair().privateKeyPkcs8,
    );
    const response = await fetch(`${baseUrl}/v1/echo`, {
      headers: stranger.headersFor({ method: 'GET', pathWithQuery: '/v1/echo', body: '' }),
    });
    expect(response.status).toBe(401);
  });

  it('the Phase-0 tiers still hold: API-key fallback authenticates; absent auth is anonymous', async () => {
    const viaKey = await fetch(`${baseUrl}/v1/echo`, { headers: { 'x-merited-agent-key': apiKey } });
    expect(await viaKey.json()).toEqual({ agent_id: agentId });
    const anonymous = await fetch(`${baseUrl}/v1/echo`);
    expect(await anonymous.json()).toEqual({ agent_id: null }); // degraded read → token: null + hint downstream (CORE-11 accepts)
  });
});
