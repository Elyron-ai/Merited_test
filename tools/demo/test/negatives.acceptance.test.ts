import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTarget, type TrioTarget } from '../../../apps/trio/contract-tests/harness.js';
import { DEMO_NEGATIVE_FIXTURES } from '../../../apps/trio/contract-tests/fixtures/demo/negative-fixtures.js';

/**
 * TRIO-15 accept, proven from the CONSUMER'S side (the demo is the customer
 * this kit exists for): each fixture provokes EXACTLY its intended code,
 * and the kit covers exactly the five §10 demo negatives with the
 * three-on-camera split. This file lives in tools/demo — not inside
 * apps/trio/contract-tests — because the frozen suite's rules.test.ts
 * allowlist (XC-7) admits no imports beyond ./harness.js, and the freeze is
 * not edited for convenience. Directory-dependent fixtures skip against
 * remote targets until TRIO-17 wires the live wallet directory.
 */

let target: TrioTarget;

beforeAll(async () => {
  target = await createTarget();
});

afterAll(async () => {
  await target.close();
});

describe('demo negative fixture kit (TRIO-15 accept)', () => {
  it('covers exactly the five §10 negatives, three of them on camera', () => {
    expect(DEMO_NEGATIVE_FIXTURES.map((f) => f.reason_code).sort()).toEqual([
      'APPROVAL_MISSING',
      'LIMIT_EXCEEDED',
      'MANDATE_REVOKED',
      'QUOTE_EXPIRED',
      'TOKEN_REPLAYED',
    ]);
    expect(DEMO_NEGATIVE_FIXTURES.filter((f) => f.staging === 'on-camera')).toHaveLength(3);
    expect(DEMO_NEGATIVE_FIXTURES.filter((f) => f.staging === 'accept-check')).toHaveLength(2);
  });

  for (const fixture of DEMO_NEGATIVE_FIXTURES) {
    it(`${fixture.reason_code}: the fixture provokes exactly its intended code`, async (ctx) => {
      if (fixture.needsDirectory && !target.directory) {
        ctx.skip(); // remote target — TRIO-17 wires the live directory
        return;
      }
      const verdict = await fixture.provoke(target);
      expect(verdict.verdict).toBe('rejected');
      if (verdict.verdict === 'rejected') {
        expect(verdict.reason_code).toBe(fixture.reason_code);
      }
    });
  }
});
