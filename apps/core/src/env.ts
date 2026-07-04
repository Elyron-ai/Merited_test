import { defineEnv } from '@merited/contracts';
import { z } from 'zod';

/**
 * Core service configuration (§8: typed env loader, MERITED_ prefix,
 * fail-fast with every missing var named). URLs have no defaults on
 * purpose — a mis-wired boot must fail loudly, not fall back silently;
 * the dev script supplies the docker-compose values explicitly.
 */
export const loadCoreEnv = (source: Record<string, string | undefined> = process.env) =>
  defineEnv(
    {
      MERITED_DATABASE_URL: z.string().url(),
      MERITED_REDIS_URL: z.string().url(),
      MERITED_CORE_PORT: z.coerce.number().int().positive().default(3100),
    },
    source,
  );

export type CoreEnv = ReturnType<typeof loadCoreEnv>;
