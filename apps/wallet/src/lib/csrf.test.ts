import { describe, expect, it } from 'vitest';
import { isCrossSite } from './csrf.js';

describe('isCrossSite — wallet CSRF (Fastify header shape, W6)', () => {
  it('blocks explicit cross-site and Origin-host mismatch', () => {
    expect(isCrossSite({ 'sec-fetch-site': 'cross-site', host: 'wallet.merited.test' })).toBe(true);
    expect(isCrossSite({ origin: 'https://evil.example', host: 'wallet.merited.test' })).toBe(true);
  });

  it('allows same-origin and non-browser (no Origin) callers', () => {
    expect(isCrossSite({ origin: 'https://wallet.merited.test', host: 'wallet.merited.test' })).toBe(false);
    expect(isCrossSite({ host: 'wallet.merited.test' })).toBe(false); // valet / wallet-ui proxy / tests
  });

  it('handles array-valued headers and malformed Origin', () => {
    expect(isCrossSite({ origin: ['https://evil.example'], host: 'wallet.merited.test' })).toBe(true);
    expect(isCrossSite({ origin: 'not-a-url', host: 'wallet.merited.test' })).toBe(true);
  });
});
