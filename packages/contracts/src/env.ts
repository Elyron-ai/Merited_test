import { z } from 'zod';

/**
 * Typed env loader (BUILD-SPEC §8: "typed env loader in packages/contracts;
 * fail fast on missing vars"). Reads the given source (default process.env),
 * validates against the Zod shape (use z.coerce.* for numbers/booleans), and
 * aggregates EVERY missing/invalid variable into one thrown report so a
 * misconfigured boot fails once with the complete list.
 */
export class EnvValidationError extends Error {
  constructor(public readonly problems: readonly string[]) {
    super(`Environment validation failed:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

export function defineEnv<T extends z.ZodRawShape>(
  shape: T,
  source: Record<string, string | undefined> = process.env,
): z.infer<z.ZodObject<T>> {
  const schema = z.object(shape);
  const input = Object.fromEntries(Object.keys(shape).map((key) => [key, source[key]]));
  const result = schema.safeParse(input);
  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const key = issue.path.join('.') || '(root)';
      const missing =
        issue.code === 'invalid_type' && 'received' in issue && issue.received === 'undefined';
      return missing ? `${key}: missing` : `${key}: ${issue.message}`;
    });
    throw new EnvValidationError(problems);
  }
  return result.data;
}
