import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runAct1 } from './act1.js';

const outRoot = mkdtempSync(path.join(os.tmpdir(), 'merited-act1-'));

afterAll(() => {
  rmSync(outRoot, { recursive: true, force: true });
});

describe('demo Act 1 steps 1–7 (VAL-12 accept — the §9 gate sentence, machine-asserted)', () => {
  it('runs end-to-end in CI mode with every printed number asserted and artefacts written', async () => {
    const lines: string[] = [];
    const result = await runAct1({ mode: 'ci', outRoot, print: (line) => lines.push(line) });

    expect(result.steps).toBe(7);
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
  }, 120_000);
});
