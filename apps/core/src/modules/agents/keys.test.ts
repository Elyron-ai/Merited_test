import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { generateApiKey, hashesEqual, hashKey } from './keys.js';

describe('agent key material (CORE-3)', () => {
  it('generates mak_-prefixed high-entropy keys with digest + last4 only', () => {
    const key = generateApiKey();
    expect(key.api_key).toMatch(/^mak_[A-Za-z0-9_-]{43}$/); // 32 bytes base64url
    expect(key.key_hash).toBe(createHash('sha256').update(key.api_key).digest('hex'));
    expect(key.key_last4).toBe(key.api_key.slice(-4));
    expect(key.key_hash).not.toContain(key.api_key);
    expect(generateApiKey().api_key).not.toBe(key.api_key);
  });

  it('hashKey is deterministic sha256 hex', () => {
    expect(hashKey('mak_x')).toBe(hashKey('mak_x'));
    expect(hashKey('mak_x')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashKey('mak_x')).not.toBe(hashKey('mak_y'));
  });

  it('hashesEqual: constant-time semantics — equal digests true, same-length mismatch false, length mismatch false', () => {
    const digest = hashKey('mak_real');
    expect(hashesEqual(digest, digest)).toBe(true);
    const flipped = digest.slice(0, -1) + (digest.endsWith('a') ? 'b' : 'a');
    expect(hashesEqual(digest, flipped)).toBe(false);
    expect(hashesEqual(digest, digest.slice(0, 32))).toBe(false);
  });
});
