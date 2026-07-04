import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module shared with the CLI
import { checkChecksums, updateChecksums } from '../scripts/check-migrations.mjs';

const makePkg = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'merited-mig-'));
  mkdirSync(path.join(root, 'drizzle'), { recursive: true });
  writeFileSync(path.join(root, 'drizzle', '0000_a.sql'), 'CREATE SCHEMA IF NOT EXISTS events;');
  return root;
};

describe('migration checksum guard (FND-9 accept, D8 forward-only)', () => {
  it('records checksums, then passes clean', () => {
    const root = makePkg();
    updateChecksums(root);
    expect(checkChecksums(root)).toEqual([]);
  });

  it('mutating an applied migration file fails the guard', () => {
    const root = makePkg();
    updateChecksums(root);
    writeFileSync(path.join(root, 'drizzle', '0000_a.sql'), 'DROP SCHEMA events;');
    const problems = checkChecksums(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/modified after being applied/);
  });

  it('a new unrecorded migration is flagged until --update records it', () => {
    const root = makePkg();
    updateChecksums(root);
    writeFileSync(path.join(root, 'drizzle', '0001_b.sql'), 'SELECT 1;');
    expect(checkChecksums(root).some((p: string) => p.includes('0001_b.sql'))).toBe(true);
    updateChecksums(root);
    expect(checkChecksums(root)).toEqual([]);
  });

  it('refuses to update the checksum of a modified applied migration', () => {
    const root = makePkg();
    updateChecksums(root);
    writeFileSync(path.join(root, 'drizzle', '0000_a.sql'), 'DROP SCHEMA events;');
    expect(() => updateChecksums(root)).toThrow(/refusing to update/);
  });
});
