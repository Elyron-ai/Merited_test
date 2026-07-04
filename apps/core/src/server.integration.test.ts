import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CoreHttpError } from './http-error.js';
import { createCoreServer, type CoreServer } from './server.js';

let app: CoreServer;

beforeAll(async () => {
  app = createCoreServer();
  // Sample schema-validated routes, registered the way modules will (CORE-3+).
  app.post(
    '/probe/echo',
    { schema: { body: z.object({ amount_pence: z.number().int().nonnegative() }) } },
    async (req) => ({ received: req.body }),
  );
  app.get('/probe/teapot', async () => {
    throw new CoreHttpError(418, 'TEAPOT', 'short and stout', 'QUOTE_EXPIRED');
  });
  app.get('/probe/boom', async () => {
    throw new Error('secret internals: db password is hunter2');
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('core server skeleton (CORE-1 accept)', () => {
  it('GET /healthz → 200', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, service: 'core' });
  });

  it('schema-invalid request → structured 400 with the Zod issue list', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/probe/echo',
      payload: { amount_pence: 'twelve pounds' },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(body.error.issues)).toBe(true);
    expect(body.error.issues.length).toBeGreaterThan(0);
    expect(body.error.issues[0]).toMatchObject({
      code: 'invalid_type',
      path: ['amount_pence'],
    });
  });

  it('schema-valid request passes through the type provider', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/probe/echo',
      payload: { amount_pence: 1200 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ received: { amount_pence: 1200 } });
  });

  it('CoreHttpError maps to the §1 envelope with reason_code passthrough', async () => {
    const res = await app.inject({ method: 'GET', url: '/probe/teapot' });
    expect(res.statusCode).toBe(418);
    expect(res.json()).toEqual({
      error: { code: 'TEAPOT', message: 'short and stout', reason_code: 'QUOTE_EXPIRED' },
    });
  });

  it('unexpected errors are an opaque 500 — internals never leak', async () => {
    const res = await app.inject({ method: 'GET', url: '/probe/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.json()).toEqual({ error: { code: 'INTERNAL', message: 'internal error' } });
    expect(res.body).not.toContain('hunter2');
  });
});
