/**
 * Clock port (TRIO-3, SYN-30): the trio has NO test backdoors — every
 * negative case is induced from public inputs (short-TTL quotes come from
 * Core's env-gated MERITED_QUOTE_TTL_S, never a trio clock override).
 * The port exists so simulators and tests inject deterministic time through
 * the constructor — not through the environment.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };
