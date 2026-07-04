/**
 * Injectable Clock (XC-5, SYN-19/30): every determinism test and the demo
 * read time through this, never `Date.now()` (ADR-008). Structurally
 * identical to the trio's production `Clock` port so a service and its
 * tests share one shape.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

/** A clock stopped at one instant — the demo's frozen time (D6). */
export const frozenClock = (iso: string): Clock => {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) throw new Error(`frozenClock: invalid instant '${iso}'`);
  return { now: () => new Date(instant) };
};

/** A clock that advances a fixed step per reading — deterministic
 * sequences where "later" must be observable (retry/backoff tests). */
export const steppingClock = (startIso: string, stepMs: number): Clock => {
  let current = new Date(startIso).getTime();
  if (Number.isNaN(current)) throw new Error(`steppingClock: invalid instant '${startIso}'`);
  return {
    now: () => {
      const reading = new Date(current);
      current += stepMs;
      return reading;
    },
  };
};
