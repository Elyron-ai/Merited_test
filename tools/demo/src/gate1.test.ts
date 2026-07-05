import { describe, expect, it } from 'vitest';
import { GATE1_CRITERIA, recordMarkdown, runGate1 } from './gate1.js';

const quiet = () => {};

describe('pnpm gate:1 aggregator (PH1-28)', () => {
  it('covers every automatable §9 Phase-1 criterion and names the manual ones', () => {
    const automated = GATE1_CRITERIA.filter((c) => c.kind === 'automated');
    const commands = automated.map((c) => c.command!).join('\n');
    expect(commands).toContain('MERITED_TEST_CRYPTO=ed25519 pnpm trio:contract-test'); // real trio
    expect(commands).toContain('mint-vs-claim-monitor.integration.test.ts'); // monitor live
    expect(commands).toContain('inspector.integration.test.ts'); // MCP inspector
    expect(commands).toContain('attenuation.property.test.ts'); // mandate properties
    expect(commands).toContain('approvals.e2e.test.ts'); // approval properties
    expect(commands).toContain('linking.integration.test.ts'); // OAuth round-trip
    expect(commands).toContain('walletless-t1.e2e.test.ts'); // walletless-T1
    expect(commands).toContain('e2e-phase1.test.ts'); // SYN-33 full-dress
    expect(commands).toContain('pnpm -r build && pnpm -r test && pnpm lint');
    const manual = GATE1_CRITERIA.filter((c) => c.kind === 'manual');
    expect(manual.map((c) => c.criterion).join(' ')).toContain('LEAD-5');
    expect(manual.map((c) => c.criterion).join(' ')).toContain('not started');
  });

  it('exits 0 iff every automated proxy passes; a failure flips to 1 and the rest still run', () => {
    expect(runGate1(() => {}, quiet).exitCode).toBe(0);
    let calls = 0;
    const flaky = runGate1(() => {
      calls += 1;
      if (calls === 2) throw new Error('boom');
    }, quiet);
    expect(flaky.exitCode).toBe(1);
    expect(flaky.results.filter((r) => r.outcome === 'fail')).toHaveLength(1);
    expect(calls).toBe(GATE1_CRITERIA.filter((c) => c.kind === 'automated').length); // no early exit
  });

  it('the record table carries one row per criterion and the verdict line', () => {
    const run = runGate1(() => {}, quiet);
    const markdown = recordMarkdown(run, '2026-07-05T12:00:00Z');
    expect(markdown.match(/\n\| /g)?.length ?? 0).toBeGreaterThanOrEqual(GATE1_CRITERIA.length);
    expect(markdown).toContain('Automated verdict: **GREEN**');
  });
});
