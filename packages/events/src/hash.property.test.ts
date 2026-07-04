import { arbEventBodySequence } from '@merited/contracts/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical-json.js';
import { chainHash, GENESIS_PREV_HASH, sha256hex } from './hash.js';

/**
 * P-6 — hash chain over generated event sequences (B2; registry
 * docs/testing/property-registry.md). The PURE half runs here in memory —
 * the same chainHash/canonicalJson the ledger writer and verify-chain use;
 * the DB-backed half (appendEvent + verify-chain over Postgres) is
 * example-tested in append/verify integration suites.
 */

interface ChainRow {
  canonical: string;
  prev_hash: string;
  this_hash: string;
}

const buildChain = (bodies: Record<string, unknown>[]): ChainRow[] => {
  const rows: ChainRow[] = [];
  let prev = GENESIS_PREV_HASH;
  for (const body of bodies) {
    const canonical = canonicalJson(body);
    const this_hash = chainHash(prev, canonical);
    rows.push({ canonical, prev_hash: prev, this_hash });
    prev = this_hash;
  }
  return rows;
};

const verifyChain = (rows: ChainRow[]): boolean => {
  let prev = GENESIS_PREV_HASH;
  for (const row of rows) {
    if (row.prev_hash !== prev) return false;
    if (chainHash(row.prev_hash, row.canonical) !== row.this_hash) return false;
    prev = row.this_hash;
  }
  return true;
};

const RUNS = { numRuns: 150, seed: 2026 };

describe('P-6 — hash chain properties', () => {
  it('any generated event sequence chains and verifies', () => {
    fc.assert(
      fc.property(arbEventBodySequence(), (bodies) => {
        expect(verifyChain(buildChain(bodies))).toBe(true);
      }),
      RUNS,
    );
  });

  it('any single-character tamper of any body breaks verification', () => {
    const arbSeqAndTamper = fc
      .tuple(arbEventBodySequence(), fc.nat(), fc.nat())
      .map(([bodies, rowPick, charPick]) => ({ bodies, rowPick, charPick }));
    fc.assert(
      fc.property(arbSeqAndTamper, ({ bodies, rowPick, charPick }) => {
        const rows = buildChain(bodies);
        const target = rows[rowPick % rows.length]!;
        const index = charPick % target.canonical.length;
        const original = target.canonical[index]!;
        const replacement = original === 'a' ? 'b' : 'a';
        target.canonical = `${target.canonical.slice(0, index)}${replacement}${target.canonical.slice(index + 1)}`;
        expect(verifyChain(rows)).toBe(false);
      }),
      RUNS,
    );
  });

  it('any tamper of any stored hash breaks verification', () => {
    fc.assert(
      fc.property(fc.tuple(arbEventBodySequence(), fc.nat()), ([bodies, pick]) => {
        const rows = buildChain(bodies);
        const target = rows[pick % rows.length]!;
        target.this_hash = sha256hex(`${target.this_hash}tampered`);
        expect(verifyChain(rows)).toBe(false);
      }),
      RUNS,
    );
  });
});
