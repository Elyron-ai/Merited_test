import { canonicalize } from 'json-canonicalize';

/**
 * Canonical JSON (FND D1): RFC 8785 (JCS) behind one swappable function —
 * the ledger writer, verify-chain, the trio and the future reference
 * verifier all use exactly this. Event bodies are Zod-validated before
 * hashing; this layer additionally rejects anything hash-unsafe: undefined
 * values, non-integer numbers (integer-pence rule, §0.4), NaN/Infinity.
 */
export class UnhashableDataError extends Error {
  constructor(path: string, problem: string) {
    super(`unhashable event data at ${path}: ${problem}`);
    this.name = 'UnhashableDataError';
  }
}

export const assertHashSafe = (value: unknown, path = '$'): void => {
  if (value === null) return;
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return;
    case 'number':
      if (!Number.isFinite(value)) throw new UnhashableDataError(path, 'non-finite number');
      if (!Number.isInteger(value)) {
        throw new UnhashableDataError(path, `float ${value} (integers only — §0.4)`);
      }
      return;
    case 'undefined':
      throw new UnhashableDataError(path, 'undefined');
    case 'object': {
      if (Array.isArray(value)) {
        value.forEach((item, i) => assertHashSafe(item, `${path}[${i}]`));
        return;
      }
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
        throw new UnhashableDataError(path, `non-plain object (${value.constructor?.name})`);
      }
      for (const [key, child] of Object.entries(value)) {
        // undefined-valued keys serialise inconsistently across writers — reject.
        assertHashSafe(child, `${path}.${key}`);
      }
      return;
    }
    default:
      throw new UnhashableDataError(path, `unsupported type ${typeof value}`);
  }
};

/** Canonicalise after asserting hash-safety. Deterministic across key order. */
export const canonicalJson = (value: unknown): string => {
  assertHashSafe(value);
  return canonicalize(value);
};
