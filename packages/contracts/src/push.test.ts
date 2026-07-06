import { describe, expect, it } from 'vitest';
import { isPublicHttpsEndpoint, PushSubscription } from './push.js';

/**
 * W11 (web-push SSRF): the push endpoint is a URL the wallet POSTs a VAPID
 * request to, so it must be an https URL to a PUBLIC host — never http, never
 * an internal/loopback/link-local address (esp. 169.254.169.254 cloud metadata).
 */
describe('web-push endpoint SSRF guard (W11)', () => {
  const keys = { p256dh: 'p', auth: 'a' };
  const sub = (endpoint: string) => PushSubscription.safeParse({ endpoint, keys });

  it('accepts a normal https push-service endpoint', () => {
    expect(isPublicHttpsEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(sub('https://push.example/live-sub').success).toBe(true);
  });

  it('rejects non-https schemes', () => {
    for (const e of ['http://push.example/x', 'ftp://push.example/x', 'file:///etc/passwd']) {
      expect(isPublicHttpsEndpoint(e)).toBe(false);
      expect(sub(e).success).toBe(false);
    }
  });

  it('rejects cloud-metadata, loopback, private and link-local IPv4 literals', () => {
    for (const host of [
      '169.254.169.254', // AWS/GCP metadata
      '127.0.0.1',
      '10.0.0.5',
      '192.168.1.1',
      '172.16.0.1',
      '172.31.255.255',
      '100.64.0.1', // CGNAT
      '0.0.0.0',
    ]) {
      expect(isPublicHttpsEndpoint(`https://${host}/push`)).toBe(false);
      expect(sub(`https://${host}/push`).success).toBe(false);
    }
  });

  it('rejects localhost and internal-suffix hostnames', () => {
    for (const host of ['localhost', 'foo.localhost', 'svc.local', 'db.internal']) {
      expect(isPublicHttpsEndpoint(`https://${host}/push`)).toBe(false);
    }
  });

  it('rejects IPv6 loopback, link-local and unique-local literals', () => {
    for (const host of ['[::1]', '[fe80::1]', '[fc00::1]', '[fd12:3456::1]', '[::ffff:127.0.0.1]']) {
      expect(isPublicHttpsEndpoint(`https://${host}/push`)).toBe(false);
    }
  });

  it('still allows a normal public IPv4 host', () => {
    expect(isPublicHttpsEndpoint('https://203.0.113.10/push')).toBe(true); // TEST-NET-3, but public-range
    expect(isPublicHttpsEndpoint('https://8.8.8.8/push')).toBe(true);
  });
});
