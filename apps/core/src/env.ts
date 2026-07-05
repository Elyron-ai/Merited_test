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
      /** PH1-4: config-selected decisioner (rules | passthrough | random:<seed>). */
      MERITED_DECISIONER: z.string().default('rules'),
    },
    source,
  );

export type CoreEnv = ReturnType<typeof loadCoreEnv>;

// ── Stripe payout rail (PH2-6, §2.2 Stripe Connect row) ─────────────────────

/**
 * LIVE-KEY GUARD (PH2-6 Accept; the Phase-2 crossing minute): no live-mode
 * key is accepted while LEAD-2 (regulatory perimeter) or LEAD-5 (security
 * audit) is unresolved. This constant IS the guard — flipping it is a
 * DELIBERATE code change that must cite both §9 resolutions in its commit.
 */
export const LIVE_RAILS_APPROVED = false; // LEAD-2 ⬜ + LEAD-5 ⬜ (BUILD-PLAN §9)

export class LiveKeyRefusedError extends Error {
  constructor() {
    super(
      'MERITED_STRIPE_SECRET_KEY is a LIVE-mode key, but live rails are not approved: ' +
        'LEAD-2 (regulatory perimeter) and LEAD-5 (security audit) must both be resolved ' +
        'in BUILD-PLAN §9 before real money moves. Use a test-mode key (sk_test_…).',
    );
  }
}

export interface StripeEnv {
  /** null = no key configured → the assembly stays on SimulatedPayouts. */
  secretKey: string | null;
  mode: 'test' | 'live' | 'absent';
}

/** The key arrives ONLY via `MERITED_STRIPE_SECRET_KEY` — a real key is an
 * environment change, never a code change (§8). */
export const loadStripeEnv = (
  source: Record<string, string | undefined> = process.env,
): StripeEnv => {
  const env = defineEnv(
    {
      // secret or restricted keys only; publishable keys can't move money
      MERITED_STRIPE_SECRET_KEY: z
        .string()
        .regex(/^(sk|rk)_(test|live)_/, 'must be a Stripe secret/restricted key')
        .optional(),
    },
    source,
  );
  const key = env.MERITED_STRIPE_SECRET_KEY ?? null;
  if (key === null) return { secretKey: null, mode: 'absent' };
  const live = /^(sk|rk)_live_/.test(key);
  if (live && !LIVE_RAILS_APPROVED) throw new LiveKeyRefusedError();
  return { secretKey: key, mode: live ? 'live' : 'test' };
};
