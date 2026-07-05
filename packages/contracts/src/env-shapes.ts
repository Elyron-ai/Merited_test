import { z } from 'zod';

/**
 * Shared Phase-1 env shapes (PH1-1, §8) for the typed loader — apps spread
 * the fragments they need into `defineEnv({...})` so every deployment
 * fails fast, once, with the complete missing-variable list. Third-party
 * CREDENTIALS are stubbed in dev/test (`stub-…` values in compose/.env per
 * the founder rule) — the validation is never stubbed: a var must exist
 * and be well-formed even when its value is a placeholder.
 */

/** Web Push (PH1-17): VAPID keys are locally GENERATED, not vendor creds. */
export const vapidEnvShape = {
  MERITED_VAPID_PUBLIC_KEY: z.string().min(1),
  MERITED_VAPID_PRIVATE_KEY: z.string().min(1),
  MERITED_VAPID_SUBJECT: z.string().regex(/^mailto:.+@.+$/),
} as const;

/** Resend mailer (PH1-7). Dev/test: stub key + Mailpit transport. */
export const resendEnvShape = {
  MERITED_RESEND_API_KEY: z.string().min(1),
  MERITED_RESEND_FROM: z.string().email(),
} as const;

/** OIDC IdP for account linking (PH1-12/13) — FakeAurora in every
 * pre-production environment (SYN-33). */
export const idpEnvShape = {
  MERITED_IDP_ISSUER: z.string().url(),
  MERITED_IDP_CLIENT_ID: z.string().min(1),
  MERITED_IDP_CLIENT_SECRET: z.string().min(1),
  MERITED_IDP_REDIRECT_URL: z.string().url(),
} as const;

/** Head-publication target (PH1-21) — a bucket name/path; dev/test point
 * at a local directory-backed publisher. */
export const headsEnvShape = {
  MERITED_HEADS_BUCKET: z.string().min(1),
} as const;

/** Everything Phase 1 adds, for apps that consume the lot. */
export const phase1EnvShape = {
  ...vapidEnvShape,
  ...resendEnvShape,
  ...idpEnvShape,
  ...headsEnvShape,
} as const;
