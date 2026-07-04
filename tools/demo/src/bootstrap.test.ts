import { describe, expect, it } from 'vitest';
import { preflight } from './bootstrap.js';

describe('clean-machine preflight (VAL-15)', () => {
  it('a healthy machine passes clean', () => {
    expect(preflight({ nodeVersion: '22.5.0', commandOk: () => true })).toEqual([]);
  });

  it('old Node fails with an actionable UK-English message', () => {
    const failures = preflight({ nodeVersion: '20.11.0', commandOk: () => true });
    expect(failures).toHaveLength(1);
    expect(failures[0]!.what).toContain('Node 20.11.0 is too old');
    expect(failures[0]!.fix).toContain('nvm install');
  });

  it('missing pnpm and a stopped Docker daemon each get their own fix', () => {
    const failures = preflight({
      nodeVersion: '22.5.0',
      commandOk: (command) => !command.startsWith('pnpm') && !command.startsWith('docker'),
    });
    expect(failures.map((f) => f.fix)).toEqual([
      expect.stringContaining('corepack enable'),
      expect.stringContaining('Start Docker Desktop'),
    ]);
  });
});
