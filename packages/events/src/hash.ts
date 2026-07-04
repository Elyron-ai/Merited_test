import { createHash } from 'node:crypto';

/**
 * Chain hashing (FND D2, BUILD-SPEC §3):
 * `this_hash = sha256(prev_hash ‖ canonical_json(body))`, lowercase hex.
 * Genesis prev_hash is sixty-four '0' characters — fixed forever once the
 * first ledger event is written.
 */
export const GENESIS_PREV_HASH = '0'.repeat(64);

export const sha256hex = (input: string): string =>
  createHash('sha256').update(input, 'utf8').digest('hex');

export const chainHash = (prevHash: string, canonicalBody: string): string =>
  sha256hex(prevHash + canonicalBody);
