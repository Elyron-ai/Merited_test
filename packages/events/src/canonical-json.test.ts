import { describe, expect, it } from 'vitest';
import { assertHashSafe, canonicalJson, UnhashableDataError } from './canonical-json.js';
import { chainHash, GENESIS_PREV_HASH, sha256hex } from './hash.js';

describe('canonicalJson (FND D1) + chainHash (FND D2)', () => {
  it('is stable across key order (property over permuted objects)', () => {
    const samples: Array<[unknown, unknown]> = [
      [{ b: 1, a: 2 }, { a: 2, b: 1 }],
      [
        { z: { y: 1, x: [1, 2, { n: 'm', k: true }] }, a: null },
        { a: null, z: { x: [1, 2, { k: true, n: 'm' }], y: 1 } },
      ],
      [
        { amount: 1200, currency: 'GBP_pence' },
        { currency: 'GBP_pence', amount: 1200 },
      ],
    ];
    for (const [left, right] of samples) {
      expect(canonicalJson(left)).toBe(canonicalJson(right));
      expect(chainHash(GENESIS_PREV_HASH, canonicalJson(left))).toBe(
        chainHash(GENESIS_PREV_HASH, canonicalJson(right)),
      );
    }
  });

  it('sorts keys lexicographically and preserves array order', () => {
    expect(canonicalJson({ b: 1, a: [3, 1, 2] })).toBe('{"a":[3,1,2],"b":1}');
  });

  it('handles unicode deterministically', () => {
    expect(canonicalJson({ title: 'Aurora spa — café £12' })).toBe(
      canonicalJson({ title: 'Aurora spa — café £12' }),
    );
  });

  it('the §3 formula: this_hash = sha256(prev_hash ‖ canonical_json(body)), genesis 64×0', () => {
    expect(GENESIS_PREV_HASH).toBe('0'.repeat(64));
    expect(GENESIS_PREV_HASH).toHaveLength(64);
    const body = { a: 1 };
    expect(chainHash(GENESIS_PREV_HASH, canonicalJson(body))).toBe(
      sha256hex('0'.repeat(64) + '{"a":1}'),
    );
    // chained: second hash links to the first
    const first = chainHash(GENESIS_PREV_HASH, canonicalJson(body));
    expect(chainHash(first, canonicalJson({ b: 2 }))).toBe(sha256hex(first + '{"b":2}'));
  });

  it('rejects floats, NaN, Infinity, undefined (pre-hash, D1)', () => {
    expect(() => canonicalJson({ amount: 12.5 })).toThrow(UnhashableDataError);
    expect(() => canonicalJson({ nested: [{ ok: 1 }, { bad: 0.1 }] })).toThrow(/float/);
    expect(() => canonicalJson({ x: NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ x: Infinity })).toThrow(/non-finite/);
    expect(() => canonicalJson({ x: undefined })).toThrow(/undefined/);
    expect(() => assertHashSafe(new Date())).toThrow(/non-plain object/);
  });

  it('accepts integers, strings, booleans, null, arrays, nested plain objects', () => {
    expect(() =>
      canonicalJson({ i: 0, s: '', b: false, n: null, arr: [1, 'two', null], o: { k: 1 } }),
    ).not.toThrow();
  });
});
