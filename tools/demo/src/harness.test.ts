import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runAct, StepFailedError, type DemoStep } from './harness.js';

const tempRoot = (): string => mkdtempSync(path.join(os.tmpdir(), 'merited-demo-'));

const step = (number: number, overrides: Partial<DemoStep> = {}): DemoStep => ({
  number,
  title: `step ${number}`,
  narrative: `Narrative for step ${number}.`,
  run: async (ctx) => {
    await ctx.artefact('result.json', JSON.stringify({ number }));
    return number;
  },
  assert: () => {},
  ...overrides,
});

describe('demo harness (VAL-11 accept)', () => {
  it('a failing assert() fails the run WITH the step number', async () => {
    const outRoot = tempRoot();
    try {
      const failing = [
        step(1),
        step(2, {
          assert: () => {
            throw new Error('splits do not balance');
          },
        }),
        step(3),
      ];
      const error = await runAct(failing, { act: 'act-test', outRoot, print: () => {} }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(StepFailedError);
      expect((error as StepFailedError).step).toBe(2);
      expect((error as StepFailedError).message).toContain('step 2');
      expect((error as StepFailedError).message).toContain('splits do not balance');
      // step 3 never ran — its artefact does not exist
      expect(existsSync(path.join(outRoot, 'act-test', 'step-03-result.json'))).toBe(false);
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });

  it('artefacts are written per step, numbered, under the act directory', async () => {
    const outRoot = tempRoot();
    try {
      const result = await runAct([step(1), step(2)], { act: 'act1', outRoot, print: () => {} });
      expect(result.artefacts).toHaveLength(2);
      const first = path.join(outRoot, 'act1', 'step-01-result.json');
      expect(existsSync(first)).toBe(true);
      expect(JSON.parse(readFileSync(first, 'utf8'))).toEqual({ number: 1 });
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });

  it('ONE step list serves both modes: human paces and narrates, CI is fast and bare', async () => {
    const outRoot = tempRoot();
    try {
      const steps = [step(1), step(2)];
      const humanLines: string[] = [];
      let slept = 0;
      await runAct(steps, {
        act: 'act1',
        outRoot,
        mode: 'human',
        paceMs: 250,
        sleep: async (ms) => {
          slept += ms;
        },
        print: (line) => humanLines.push(line),
      });
      expect(slept).toBe(500); // paced between steps
      expect(humanLines.join('\n')).toContain('Narrative for step 1.');

      const ciLines: string[] = [];
      const ciResult = await runAct(steps, {
        act: 'act1',
        outRoot,
        mode: 'ci',
        paceMs: 250,
        sleep: async () => {
          throw new Error('CI mode must not pace');
        },
        print: (line) => ciLines.push(line),
      });
      expect(ciResult.mode).toBe('ci');
      expect(ciLines.join('\n')).not.toContain('Narrative');
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });

  it('act-agnostic: a second act writes under its own directory unchanged', async () => {
    const outRoot = tempRoot();
    try {
      await runAct([step(1)], { act: 'act2', outRoot, print: () => {} });
      expect(existsSync(path.join(outRoot, 'act2', 'step-01-result.json'))).toBe(true);
    } finally {
      rmSync(outRoot, { recursive: true, force: true });
    }
  });
});
