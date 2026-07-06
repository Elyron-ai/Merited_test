/**
 * W11 (dev-secret fail-open): resolve a secret from the environment, falling
 * back to a well-known DEV default ONLY outside production. The dev fallbacks
 * (`control-plane-dev-secret`, `trio-dev-secret`, `dev-service-token`) live in
 * the source tree, so silently adopting one in production would mint forgeable
 * operator session cookies and hand out a publicly-known inter-service token.
 * In production an unset secret is fatal — fail fast at first use rather than
 * run on a compromised default. Same production gate as the W8 Secure cookie
 * and HSTS (`NODE_ENV==='production' && MERITED_ENV!=='dev'`).
 */
const isProduction = (): boolean =>
  process.env.NODE_ENV === 'production' && process.env['MERITED_ENV'] !== 'dev';

export const secretFromEnv = (envVar: string, devFallback: string): string => {
  const value = process.env[envVar];
  if (value) return value;
  if (isProduction()) {
    throw new Error(
      `${envVar} must be set in production — refusing the public dev fallback (would be forgeable)`,
    );
  }
  return devFallback;
};
