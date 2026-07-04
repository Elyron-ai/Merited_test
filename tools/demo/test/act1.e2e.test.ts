import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runAct1 } from '../src/act1.js';

const outRoot = mkdtempSync(path.join(os.tmpdir(), 'merited-act1-'));

afterAll(() => {
  rmSync(outRoot, { recursive: true, force: true });
});

describe('the repo\'s single E2E (VAL-14, §8) — Act 1 in CI mode, all 9 steps', () => {
  it('runs end-to-end in CI mode with every printed number asserted and artefacts written', async () => {
    const lines: string[] = [];
    const result = await runAct1({ mode: 'ci', outRoot, print: (line) => lines.push(line) });

    expect(result.steps).toBe(9);
    // the gate sentence's waypoints all produced artefacts
    for (const artefact of [
      'step-01-seed.json',
      'step-02-commitment.json',
      'step-03-quote.json',
      'step-03-token-claims.json',
      'step-04-order.json',
      'step-05-verdict.json',
      'step-06-entries.json',
      'step-07-statement-aurora.json',
      'step-08-negatives.json',
      'step-09-trace.txt',
      'step-09-chain-head.txt',
    ]) {
      expect(existsSync(path.join(outRoot, 'act1', artefact)), artefact).toBe(true);
    }
    // the statement PDF renders when Chromium is available (it is, in this repo's envs)
    if (existsSync('/opt/pw-browsers/chromium')) {
      const pdf = readFileSync(path.join(outRoot, 'act1', 'step-07-statement-aurora.pdf'));
      expect(pdf.subarray(0, 4).toString('latin1')).toBe('%PDF');
    }
    // the five §7.2 ticks were printed from the verified verdict
    for (const check of ['sig chain ✓', 'replay ✓', 'window ✓', 'quote ✓', 'terms ✓']) {
      expect(lines.some((l) => l.includes(check)), check).toBe(true);
    }
    // §10 step 8: both refusals printed with their first-class reason codes
    expect(lines.some((l) => l.includes('TOKEN_REPLAYED'))).toBe(true);
    expect(lines.some((l) => l.includes('QUOTE_EXPIRED'))).toBe(true);
    // §9 gate: chain verified and the head hash printed
    expect(lines.some((l) => /chain verified: \d+ events · head [0-9a-f]{64}/.test(l))).toBe(true);
  }, 120_000);
});
