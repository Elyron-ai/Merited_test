import { readFileSync } from 'node:fs';

/**
 * Canonical fixture loader (XC-5, SYN-19): JSON fixtures come in parsed,
 * optionally schema-validated, and DEEP-FROZEN — a test that mutates a
 * shared fixture corrupts every later assertion in the worst silent way,
 * so mutation fails loudly instead. Byte-identity assertions belong to the
 * consumer via @merited/events' canonicalJson (events depends on contracts,
 * so the kit cannot import it — dependency direction, §1).
 */

export const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};

export interface FixtureSchema<T> {
  parse(data: unknown): T;
}

/** Load a JSON fixture file; validate through `schema` when given. */
export function loadFixture<T>(filePath: string, schema: FixtureSchema<T>): Readonly<T>;
export function loadFixture(filePath: string): unknown;
export function loadFixture<T>(filePath: string, schema?: FixtureSchema<T>): unknown {
  const raw = readFileSync(filePath, 'utf8');
  const data: unknown = JSON.parse(raw);
  return deepFreeze(schema ? schema.parse(data) : data);
}
