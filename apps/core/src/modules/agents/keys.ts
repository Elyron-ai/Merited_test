import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Agent API key material (CORE-3, B4): `mak_` + 256 bits of entropy,
 * base64url. Only the SHA-256 hex digest and the last four characters are
 * ever stored — the clear key crosses the wire exactly once.
 */
export interface GeneratedKey {
  api_key: string;
  key_hash: string;
  key_last4: string;
}

export const hashKey = (apiKey: string): string =>
  createHash('sha256').update(apiKey, 'utf8').digest('hex');

export const generateApiKey = (): GeneratedKey => {
  const api_key = `mak_${randomBytes(32).toString('base64url')}`;
  return { api_key, key_hash: hashKey(api_key), key_last4: api_key.slice(-4) };
};

/** Constant-time digest comparison (both sides are 64-char hex). */
export const hashesEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
};
