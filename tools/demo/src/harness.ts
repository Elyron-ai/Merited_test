import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Demo step runner (VAL-11, §8/§10). ONE step list serves two modes —
 * human (paced, formatted, on-camera narratives) and CI (fast, assertions
 * only) — which is what makes the demo LITERALLY be the E2E test. The
 * harness is act-agnostic: Act 2 (Phase 2) reuses `runAct` unchanged.
 */

export type DemoMode = 'human' | 'ci';

export interface StepContext {
  mode: DemoMode;
  /** This act's artefact directory (JSON dumps, PDFs, trace URLs, chain head). */
  outDir: string;
  print(line: string): void;
  /** Persist an artefact for the CURRENT step; returns its path. */
  artefact(name: string, content: string | Uint8Array): Promise<string>;
}

export interface DemoStep<T = unknown> {
  number: number;
  title: string;
  /** UK English, printed on camera in human mode. */
  narrative: string;
  run(ctx: StepContext): Promise<T>;
  /** Machine checks — a throw here fails the whole run with this step's number. */
  assert(result: T, ctx: StepContext): void | Promise<void>;
}

export class StepFailedError extends Error {
  constructor(
    public readonly step: number,
    public readonly title: string,
    cause: unknown,
  ) {
    super(
      `step ${step} (${title}) failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'StepFailedError';
    this.cause = cause;
  }
}

export interface RunActOptions {
  /** Names the artefact directory: `<outRoot>/<act>/`. */
  act: string;
  mode?: DemoMode;
  outRoot?: string;
  print?(line: string): void;
  /** Human-mode pause between steps; injectable for tests. */
  paceMs?: number;
  sleep?(ms: number): Promise<void>;
}

export interface ActResult {
  act: string;
  mode: DemoMode;
  steps: number;
  artefacts: string[];
}

const BOLD = '[1m';
const DIM = '[2m';
const RESET = '[0m';

export const runAct = async (steps: DemoStep[], options: RunActOptions): Promise<ActResult> => {
  const mode: DemoMode =
    options.mode ?? (process.env['MERITED_DEMO_MODE'] === 'human' ? 'human' : 'ci');
  const print = options.print ?? ((line: string) => console.log(line));
  const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const outDir = path.join(options.outRoot ?? path.join(process.cwd(), 'out'), options.act);
  await mkdir(outDir, { recursive: true });

  const artefacts: string[] = [];
  for (const step of steps) {
    const context: StepContext = {
      mode,
      outDir,
      print,
      artefact: async (name, content) => {
        const file = path.join(outDir, `step-${String(step.number).padStart(2, '0')}-${name}`);
        await writeFile(file, content);
        artefacts.push(file);
        return file;
      },
    };
    if (mode === 'human') {
      print(`${BOLD}Step ${step.number} — ${step.title}${RESET}`);
      print(`${DIM}${step.narrative}${RESET}`);
    } else {
      print(`step ${step.number}: ${step.title}`);
    }
    try {
      const result = await step.run(context);
      await step.assert(result, context);
    } catch (cause) {
      throw new StepFailedError(step.number, step.title, cause);
    }
    if (mode === 'human' && (options.paceMs ?? 0) > 0) await sleep(options.paceMs!);
  }
  return { act: options.act, mode, steps: steps.length, artefacts };
};
