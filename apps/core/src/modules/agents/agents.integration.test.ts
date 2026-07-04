import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateCore } from '../../../scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../packages/events/scripts/migrate.mjs';
import { InMemoryRateLimiter } from '../adapters/rate-limiter/in-memory.js';
import { createCoreServer, type CoreServer } from '../../server.js';
import { registerAgentAuth } from './auth.js';
import { registerAgentRoutes } from './routes.js';
import { AgentsService } from './service.js';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_agt_${Date.now().toString(36)}`;

let admin: pg.Client;
let pool: pg.Pool;
let service: AgentsService;
let app: CoreServer;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const adminUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(adminUrl); // events schema — AgentRegistered lands in the ledger
  await migrateCore(adminUrl);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 10,
  });
  pool.on('error', () => {});
  service = new AgentsService(pool);

  app = createCoreServer();
  registerAgentRoutes(app, service, {
    registerLimiter: new InMemoryRateLimiter({ limit: 3, windowS: 3600 }),
  });
  registerAgentAuth(app, {
    authenticate: (key) => service.authenticate(key),
    limiter: new InMemoryRateLimiter({ limit: 5, windowS: 3600 }),
  });
  app.get('/v1/whoami', async (req) => ({ agent_id: req.agentCtx.agent_id }));
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('agent registry (CORE-3 accept)', () => {
  it('register returns the key exactly once; only digest + last4 are stored; event emitted', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/register',
      payload: { name: 'Valet', contact: 'valet@example.test' },
    });
    expect(res.statusCode).toBe(200);
    const { agent_id, api_key } = res.json();
    expect(agent_id).toMatch(/^agt_/);
    expect(api_key).toMatch(/^mak_/);

    const { rows } = await pool.query(
      `SELECT key_hash, key_last4, alg, public_key, revoked_at FROM core.agent_keys WHERE agent_id = $1`,
      [agent_id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].key_hash).not.toBe(api_key);
    expect(rows[0].key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].key_last4).toBe(api_key.slice(-4));
    expect(rows[0].alg).toBe('api_key');
    expect(rows[0].revoked_at).toBeNull();

    const events = await pool.query(
      `SELECT body->'data'->>'agent_id' AS agent_id FROM events.events WHERE type = 'AgentRegistered'`,
    );
    expect(events.rows.map((r) => r.agent_id)).toContain(agent_id);
  });

  it('B4 split: absent header → anonymous ctx (not 401); invalid key → 401; valid key → agent ctx', async () => {
    const registered = await service.register({ name: 'A2', contact: 'a2@example.test' });

    const anonymous = await app.inject({ method: 'GET', url: '/v1/whoami' });
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json()).toEqual({ agent_id: null });

    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { 'x-merited-agent-key': 'mak_definitely-not-a-real-key-000000000000' },
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json().error.code).toBe('AGENT_AUTH_FAILED');

    const valid = await app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { 'x-merited-agent-key': registered.api_key },
    });
    expect(valid.statusCode).toBe(200);
    expect(valid.json()).toEqual({ agent_id: registered.agent_id });
  });

  it('revocation takes effect on the next request', async () => {
    const registered = await service.register({ name: 'A3', contact: 'a3@example.test' });
    expect(await service.authenticate(registered.api_key)).toBe(registered.agent_id);
    expect(await service.revokeKeys(registered.agent_id)).toBe(1);
    expect(await service.authenticate(registered.api_key)).toBeNull();
    const res = await app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { 'x-merited-agent-key': registered.api_key },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rate limits: register is IP-limited and authed requests are per-agent limited → 429 + Retry-After', async () => {
    // register limiter: limit 3/window; the suite has already used 1 — burn the rest.
    let lastStatus = 200;
    for (let i = 0; i < 4; i += 1) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/agents/register',
        payload: { name: `Burst ${i}`, contact: 'burst@example.test' },
      });
      lastStatus = res.statusCode;
      if (res.statusCode === 429) {
        expect(res.json().error.code).toBe('RATE_LIMITED');
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
        break;
      }
    }
    expect(lastStatus).toBe(429);

    // per-agent limit (5/window) on the authed surface
    const registered = await service.register({ name: 'A4', contact: 'a4@example.test' });
    let denied: number | null = null;
    for (let i = 0; i < 7; i += 1) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/whoami',
        headers: { 'x-merited-agent-key': registered.api_key },
      });
      if (res.statusCode === 429) {
        denied = i;
        expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
        break;
      }
    }
    expect(denied).not.toBeNull();
  });
});
