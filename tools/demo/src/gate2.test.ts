import { describe, expect, it } from 'vitest';
import { GATE2_CRITERIA, recordMarkdown, runGate2 } from './gate2.js';

const quiet = () => {};

describe('pnpm gate:2 aggregator (PH2-12)', () => {
  it('covers every automatable §9 Phase-2 clause and names the manual ones', () => {
    const commands = GATE2_CRITERIA.filter((c) => c.kind === 'automated').map((c) => c.command!).join('\n');
    expect(commands).toContain('act2.e2e.test.ts'); // the gate sentence + negatives + trace
    expect(commands).toContain('decisioner-swap.integration.test.ts'); // zero API changes
    expect(commands).toContain('payouts/'); // Stripe rail parity + guard
    expect(commands).toContain('guardrails.integration.test.ts'); // §5.6
    expect(commands).toContain('dashboard.e2e.test.ts'); // B19 dashboard
    expect(commands).toContain('points-credit.integration.test.ts'); // PH2-10
    expect(commands).toContain('pd-reader.integration.test.ts'); // PH2-9
    expect(commands).toContain('pnpm -r build && pnpm -r test && pnpm lint');
    const manual = GATE2_CRITERIA.filter((c) => c.kind === 'manual').map((c) => c.criterion).join(' ');
    expect(manual).toContain('Stripe Connect test-mode transfer');
    expect(manual).toContain('recorded on camera');
    expect(manual).toContain('Phase-3 modules not started');
  });

  it('exit 0 iff every automated criterion passes; manual rows never gate the script', () => {
    const green = runGate2(() => {}, quiet);
    expect(green.exitCode).toBe(0);
    expect(green.results.filter((r) => r.outcome === 'manual').length).toBeGreaterThanOrEqual(3);

    let first = true;
    const red = runGate2(() => {
      if (first) { first = false; throw new Error('boom'); }
    }, quiet);
    expect(red.exitCode).toBe(1);
    expect(red.results.filter((r) => r.outcome === 'fail')).toHaveLength(1);
  });

  it('the record table marks pass/fail/manual and the verdict line', () => {
    const run = runGate2(() => {}, quiet);
    const md = recordMarkdown(run, '2026-07-05T00:00:00Z');
    expect(md).toContain('## Gate 2 run — 2026-07-05T00:00:00Z');
    expect(md).toContain('✅ pass');
    expect(md).toContain('◻ manual');
    expect(md).toContain('Automated verdict: **GREEN**');
  });
});
