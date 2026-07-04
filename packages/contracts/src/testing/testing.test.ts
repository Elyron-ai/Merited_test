import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Id } from '../ids.js';
import { frozenClock, steppingClock } from './clock.js';
import { seededIdFactory } from './seeded-ids.js';
import { deepFreeze, loadFixture } from './fixtures.js';

describe('deterministic test kit (XC-5, SYN-19)', () => {
  it('the same seed yields the same ID sequence — byte-stable fixtures', () => {
    const a = seededIdFactory(7);
    const b = seededIdFactory(7);
    const seqA = [a.next('off'), a.next('off'), a.next('com'), a.next('qte')];
    const seqB = [b.next('off'), b.next('off'), b.next('com'), b.next('qte')];
    expect(seqA).toEqual(seqB);
    expect(new Set(seqA).size).toBe(4);
  });

  it('different seeds diverge; every minted ID validates against contracts Id()', () => {
    const a = seededIdFactory(1);
    const b = seededIdFactory(2);
    expect(a.ulid()).not.toBe(b.ulid());
    const factory = seededIdFactory();
    for (const prefix of ['mer', 'off', 'com', 'atk', 'clm'] as const) {
      expect(() => Id(prefix).parse(factory.next(prefix))).not.toThrow();
    }
  });

  it('the ID stream is monotonic — sortable in mint order', () => {
    const factory = seededIdFactory();
    const stream = Array.from({ length: 50 }, () => factory.ulid());
    expect([...stream].sort()).toEqual(stream);
  });

  it('frozenClock always reads the same instant; readings are defensive copies', () => {
    const clock = frozenClock('2026-07-04T12:00:00Z');
    const first = clock.now();
    first.setFullYear(1999); // a test mutating its reading must not move time
    expect(clock.now().toISOString()).toBe('2026-07-04T12:00:00.000Z');
    expect(frozenClock('2026-07-04T12:00:00Z').now().getTime()).toBe(clock.now().getTime());
  });

  it('steppingClock advances deterministically per reading', () => {
    const clock = steppingClock('2026-07-04T12:00:00Z', 1_000);
    expect(clock.now().toISOString()).toBe('2026-07-04T12:00:00.000Z');
    expect(clock.now().toISOString()).toBe('2026-07-04T12:00:01.000Z');
    expect(clock.now().toISOString()).toBe('2026-07-04T12:00:02.000Z');
  });

  it('rejects invalid instants loudly', () => {
    expect(() => frozenClock('not a date')).toThrow('invalid instant');
    expect(() => steppingClock('nope', 1)).toThrow('invalid instant');
  });

  it('loadFixture parses, validates through the schema, and deep-freezes', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'merited-kit-'));
    const file = path.join(dir, 'fixture.json');
    writeFileSync(file, JSON.stringify({ amount: 1200, nested: { tier: 'T1' } }));
    try {
      const schema = z.object({ amount: z.number().int(), nested: z.object({ tier: z.string() }) });
      const fixture = loadFixture(file, schema);
      expect(fixture.amount).toBe(1200);
      expect(Object.isFrozen(fixture)).toBe(true);
      expect(Object.isFrozen(fixture.nested)).toBe(true);
      expect(() => {
        (fixture.nested as { tier: string }).tier = 'T3';
      }).toThrow(TypeError);
      // schema violations refuse at the door
      writeFileSync(file, JSON.stringify({ amount: 12.5, nested: { tier: 'T1' } }));
      expect(() => loadFixture(file, schema)).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deepFreeze freezes cyclic-free trees including arrays', () => {
    const tree = deepFreeze({ list: [{ a: 1 }, { b: 2 }] });
    expect(Object.isFrozen(tree.list)).toBe(true);
    expect(Object.isFrozen(tree.list[0])).toBe(true);
  });
});
