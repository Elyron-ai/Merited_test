import type { Signer } from '@merited/signing';
import type { Clock } from './clock.js';

const PREFIX = 'svt.v1';
export const SERVICE_TOKEN_KEY = 'platform/service';
export const SERVICE_TOKEN_MAX_SKEW_S = 300; // SYN-24's window

/**
 * Signed service tokens (PH1-25, arch §6): Core→trio auth hardened from a
 * static shared secret to short-lived signed tokens — `svt.v1.<unix
 * seconds>.<signature over "svt.v1\n<ts>">` under the platform service
 * key. The static token remains accepted alongside (dev + migration);
 * deployments flip to signed-only by configuration. Verification is
 * signature-first, then ±300s skew.
 */
export const signServiceToken = async (signer: Signer, clock: Clock): Promise<string> => {
  const ts = Math.floor(clock.now().getTime() / 1000);
  const signature = await signer.sign(SERVICE_TOKEN_KEY, `${PREFIX}\n${ts}`);
  return `${PREFIX}.${ts}.${signature}`;
};

export const verifyServiceToken = async (
  signer: Signer,
  clock: Clock,
  token: string,
): Promise<boolean> => {
  const match = /^svt\.v1\.(\d{1,12})\.(.+)$/.exec(token);
  if (!match) return false;
  const [, ts, signature] = match;
  if (!(await signer.verify(SERVICE_TOKEN_KEY, `${PREFIX}\n${ts}`, signature!))) return false;
  const skew = Math.abs(Math.floor(clock.now().getTime() / 1000) - Number.parseInt(ts!, 10));
  return skew <= SERVICE_TOKEN_MAX_SKEW_S;
};
