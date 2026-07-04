import { describe, expect, it } from 'vitest';
import { GATE0_CRITERIA, recordMarkdown, runGate0 } from './gate0.js';

const quiet = () => {};

describe('pnpm gate:0 aggregator (XC-9)', () => {
  it('covers every automatable §9 Phase 0 criterion and names the manual ones', () => {
    const automated = GATE0_CRITERIA.filter((c) => c.kind === 'automated');
    const commands = automated.map((c) => c.command!).join('\n');
    // the six automated proxies the row demands: unit/property, lint,
    // contract suite, verify-chain, demo E2E, clean-machine smoke
    expect(commands).toContain('pnpm -r build && pnpm -r test');
    expect(commands).toContain('pnpm lint');
    expect(commands).toContain('pnpm trio:contract-test');
    expect(commands).toContain('pnpm verify-chain');
    expect(commands).toContain('act1.e2e.test.ts test/mutation.test.ts');
    expect(commands).toContain('MERITED_DEMO_MODE=ci pnpm demo:act1');
    const manual = GATE0_CRITERIA.filter((c) => c.kind === 'manual');
    expect(manual.map((c) => c.criterion).join(' ')).toContain('Demo recorded');
    expect(manual.map((c) => c.criterion).join(' ')).toContain('not started');
  });

  it('exits 0 iff every automated proxy passes', () => {
    const allPass = runGate0(() => {}, quiet);
    expect(allPass.exitCode).toBe(0);
    expect(allPass.results.filter((r) => r.outcome === 'fail')).toEqual([]);
  });

  it('any failing proxy makes the exit code 1 — and the rest still run', () => {
    let calls = 0;
    const run = runGate0((command) => {
      calls += 1;
      if (command === 'pnpm verify-chain') throw new Error('chain broken');
    }, quiet);
    expect(run.exitCode).toBe(1);
    expect(run.results.filter((r) => r.outcome === 'fail')).toHaveLength(1);
    expect(calls).toBe(GATE0_CRITERIA.filter((c) => c.kind === 'automated').length);
  });

  it('manual items never affect the exit code, but always appear in the record', () => {
    const run = runGate0(() => {}, quiet);
    expect(run.results.filter((r) => r.outcome === 'manual').length).toBeGreaterThanOrEqual(2);
    const record = recordMarkdown(run, '2026-07-04T00:00:00Z');
    expect(record).toContain('◻ manual');
    expect(record).toContain('GREEN');
    expect(record).toContain('| ✅ pass |');
  });

  it('a red run records RED', () => {
    const run = runGate0(() => {
      throw new Error('everything is broken');
    }, quiet);
    expect(recordMarkdown(run, '2026-07-04T00:00:00Z')).toContain('RED');
  });
});
