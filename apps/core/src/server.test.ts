import { describe, expect, it } from 'vitest';
import { createCoreServer } from './server.js';

describe('createCoreServer hardening (W7/#25 — slowloris)', () => {
  it('applies finite request + connection timeouts (Fastify defaults 0 = disabled)', () => {
    const cfg = createCoreServer().initialConfig as {
      connectionTimeout?: number;
      requestTimeout?: number;
    };
    expect(cfg.connectionTimeout).toBe(30_000);
    expect(cfg.requestTimeout).toBe(30_000);
  });
});
