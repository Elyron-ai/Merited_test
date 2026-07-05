import { describe, expect, it } from 'vitest';
import { GATE3_CRITERIA, recordMarkdown, runGate3 } from './gate3.js';

const quiet = () => {};

describe('pnpm gate:3 aggregator (PH3-10)', () => {
  it('covers all three §9 Phase-3 clauses and names the manual/founder rows', () => {
    const clauses = GATE3_CRITERIA.filter((c) => c.criterion.startsWith('GATE CLAUSE'));
    expect(clauses).toHaveLength(3);
    const commands = GATE3_CRITERIA.filter((c) => c.kind === 'automated')
      .map((c) => c.command!)
      .join('\n');
    expect(commands).toContain('@merited/verifier test'); // clause 1
    expect(commands).toContain('feed.integration.test.ts'); // clause 2
    expect(commands).toContain('signup.e2e.test.ts'); // clause 3
    expect(commands).toContain('src/modules/adapters/ucp/'); // interop
    expect(commands).toContain('shopify-rail.e2e.test.ts'); // three rails
    expect(commands).toContain('sku-granularity.integration.test.ts'); // PH3-9
    expect(commands).toContain('pnpm -r build && pnpm -r test && pnpm lint');
    const manual = GATE3_CRITERIA.filter((c) => c.kind === 'manual').map((c) => c.criterion).join(' ');
    expect(manual).toContain('clean-container run');
    expect(manual).toContain('Shopify dev-store');
    expect(manual).toContain('Founder gate acceptance');
  });

  it('aggregates pass/fail correctly and fails the run on any automated failure', () => {
    const allPass = runGate3(() => {}, quiet);
    expect(allPass.exitCode).toBe(0);
    expect(allPass.results.filter((r) => r.outcome === 'manual').length).toBeGreaterThanOrEqual(4);

    let first = true;
    const oneFail = runGate3(() => {
      if (first) {
        first = false;
        throw new Error('boom');
      }
    }, quiet);
    expect(oneFail.exitCode).toBe(1);
    expect(oneFail.results.filter((r) => r.outcome === 'fail')).toHaveLength(1);
  });

  it('records a markdown table with the verdict line', () => {
    const run = runGate3(() => {}, quiet);
    const md = recordMarkdown(run, '2026-07-05T00:00:00Z');
    expect(md).toContain('## Gate 3 run — 2026-07-05T00:00:00Z');
    expect(md).toContain('| ✅ pass |');
    expect(md).toContain('| ◻ manual |');
    expect(md).toContain('Automated verdict: **GREEN** (exit 0)');
  });
});
