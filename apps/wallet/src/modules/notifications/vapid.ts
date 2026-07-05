import { defineEnv, vapidEnvShape } from '@merited/contracts';
import webpush from 'web-push';

/**
 * VAPID configuration (PH1-17, B25). Env-configured via the contracts typed
 * env loader (§8): `vapidFromEnv` validates the three MERITED_VAPID_* vars
 * through `defineEnv(vapidEnvShape)` and fails fast, once, with the complete
 * missing-variable list. Keys are first-party — no push vendor (§2.2 has no
 * push row); a real deployment sets a generated keypair in env, dev/test call
 * `generateVapidKeys()` (a real key is an env change, never a code change).
 */
export interface VapidConfig {
  publicKey: string;
  privateKey: string;
  subject: string; // mailto: contact per RFC 8292
}

export const vapidFromEnv = (env: NodeJS.ProcessEnv = process.env): VapidConfig => {
  const parsed = defineEnv(vapidEnvShape, env);
  return {
    publicKey: parsed.MERITED_VAPID_PUBLIC_KEY,
    privateKey: parsed.MERITED_VAPID_PRIVATE_KEY,
    subject: parsed.MERITED_VAPID_SUBJECT,
  };
};

/** Fresh P-256 VAPID keypair (dev/test convenience; prod keys live in env). */
export const generateVapidKeys = (): { publicKey: string; privateKey: string } =>
  webpush.generateVAPIDKeys();
