import { REJECTION_REASON_CODES } from '@merited/contracts';
import { describe, expect, it } from 'vitest';
import { REASON_COPY, explain } from '../src/lib/reason-copy';

describe('reason-code copy (MER-10 — every §3 code renders with an explanation)', () => {
  it('covers EXACTLY the twelve §3 codes — a new contracts code fails here until explained', () => {
    expect(Object.keys(REASON_COPY).sort()).toEqual([...REJECTION_REASON_CODES].sort());
    expect(REJECTION_REASON_CODES).toHaveLength(12);
  });

  it('every line is one sentence of UK English, non-empty', () => {
    for (const code of REJECTION_REASON_CODES) {
      const line = explain(code);
      expect(line.length, code).toBeGreaterThan(20);
      expect(line.trim().endsWith('.'), code).toBe(true);
    }
  });
});
