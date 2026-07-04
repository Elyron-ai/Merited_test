import { monotonicFactory } from 'ulidx';
import type { IdPrefix, MeritedId } from '../ids.js';

/**
 * Seeded monotonic ULID factory (XC-5, SYN-18/19, ADR-002): the same seed
 * always yields the same ID sequence, so fixtures built through the kit are
 * byte-stable across runs and machines — no more hand-writing 26-char
 * Crockford bodies (the build log records two rounds of invalid hand-cut
 * IDs; this is the fix).
 */

/** mulberry32 — tiny deterministic PRNG; quality is irrelevant here, only
 * repeatability matters (tests, never production randomness). */
const mulberry32 = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** The demo's frozen epoch (D6) — all seeded ULIDs share one timestamp so
 * ordering comes from the monotonic counter, not the wall clock. */
export const SEEDED_EPOCH = Date.parse('2026-07-01T00:00:00Z');

export interface SeededIdFactory {
  /** Mint the next typed ID: `<prefix>_<26-char Crockford ULID>`. */
  next<P extends IdPrefix>(prefix: P): MeritedId<P>;
  /** The raw 26-char ULID stream, for non-prefixed uses. */
  ulid(): string;
}

export const seededIdFactory = (seed = 42): SeededIdFactory => {
  const ulid = monotonicFactory(mulberry32(seed));
  return {
    next: <P extends IdPrefix>(prefix: P): MeritedId<P> => `${prefix}_${ulid(SEEDED_EPOCH)}`,
    ulid: () => ulid(SEEDED_EPOCH),
  };
};
