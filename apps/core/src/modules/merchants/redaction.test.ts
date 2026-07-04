import { Writable } from 'node:stream';
import { createLogger } from '@merited/otel';
import { describe, expect, it } from 'vitest';

/** MER-2 accept: secrets never appear in logs. The shared logger's redact
 * paths cover every credential field this module handles. */
describe('log redaction of merchant credentials', () => {
  it('api keys, secrets and credential headers are censored at the sink', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const logger = createLogger('redaction-test', sink);
    logger.info(
      {
        merchant: { api_key: 'mmk_super-secret-key', secret: 'whsec_super-secret' },
        api_key: 'mmk_top-level',
        webhook_secret: 'whsec_top-level',
        req: { headers: { 'x-merited-merchant-key': 'mmk_header-borne' } },
      },
      'merchant onboarded',
    );
    await new Promise((resolve) => setTimeout(resolve, 20)); // pino flush

    const output = lines.join('');
    expect(output).toContain('merchant onboarded');
    expect(output).not.toContain('mmk_super-secret-key');
    expect(output).not.toContain('whsec_super-secret');
    expect(output).not.toContain('mmk_top-level');
    expect(output).not.toContain('whsec_top-level');
    expect(output).not.toContain('mmk_header-borne');
    expect(output).toContain('[Redacted]');
  });
});
