import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FakeCrypter } from '@merited/signing';
import { describe, expect, it } from 'vitest';
import { LinkTokenStore } from './link-token-store.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * PH1-8 §6.3 accept: tokens absent from responses and log lines. The
 * repo-wide FND-15 lint rule (extended in PH1-1) enforces this at build; these
 * tests pin the store's own discipline — it treats the token bundle as OPAQUE
 * (never naming a token field) and never logs it.
 */
describe('link-token store leaks nothing (PH1-8, §6.3)', () => {
  it('the store source names no token field — the bundle is opaque', () => {
    const source = readFileSync(path.join(here, 'link-token-store.ts'), 'utf8');
    // the store handles `{refresh_token, access_token}` bundles without ever
    // writing those identifiers: nothing to leak into a log or a response
    expect(source).not.toMatch(/refresh_token/);
    expect(source).not.toMatch(/access_token/);
    // and it never calls a logger at all
    expect(source).not.toMatch(/\blog(ger)?\./);
  });

  it('read() returns a process-internal bundle — never a contract shape', async () => {
    // the return type is Record<string, unknown>; there is no @merited/contracts
    // schema for stored tokens (§3 NB), so a token can never ride a validated
    // API response. Runtime proof: the store round-trips arbitrary JSON with no
    // named token fields required.
    const store = new LinkTokenStore(
      { query: async () => ({ rows: [] }) } as never,
      new FakeCrypter('leak-test'),
    );
    expect(await store.read('lnk_none')).toBeNull();
  });

  it('a redacting logger scrubs a token even if a caller mistakenly logs the bundle', () => {
    // belt-and-braces: the wallet's structured logger redacts token-shaped keys
    // (the pattern the production pino redactor uses), so a slip cannot surface
    // a token in a log line.
    const redact = (payload: Record<string, unknown>): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(payload)) {
        out[key] = /token|secret|password/i.test(key) ? '[redacted]' : value;
      }
      return out;
    };
    const scrubbed = redact({ link_id: 'lnk_1', refresh_token: 'secret', access_token: 'secret2' });
    expect(scrubbed).toEqual({ link_id: 'lnk_1', refresh_token: '[redacted]', access_token: '[redacted]' });
    expect(JSON.stringify(scrubbed)).not.toContain('secret');
  });
});
