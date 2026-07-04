import argon2 from 'argon2';
import { verify as verifyTotp } from 'otplib';
import type pg from 'pg';

/** A real argon2id hash of random bytes — verified against when the email is
 * unknown so unknown-vs-wrong-password timing stays uniform (no user oracle). */
const DUMMY_HASH_PROMISE = argon2.hash('merited-dummy-password', { type: argon2.argon2id });

export interface Credentials {
  email: string;
  password: string;
  totp: string;
}

/**
 * Full credential check (MER-7, §5.7): argon2id password AND a live TOTP.
 * Uniform null on ANY failure — unknown email, wrong password and wrong
 * TOTP are indistinguishable to the caller.
 */
export const authenticate = async (
  pool: pg.Pool,
  credentials: Credentials,
): Promise<{ user_id: string } | null> => {
  const { rows } = await pool.query<{ user_id: string; password_hash: string; totp_secret: string }>(
    `SELECT user_id, password_hash, totp_secret FROM control_plane.users WHERE email = $1`,
    [credentials.email],
  );
  const user = rows[0];
  const hash = user?.password_hash ?? (await DUMMY_HASH_PROMISE);
  const passwordOk = await argon2.verify(hash, credentials.password).catch(() => false);
  if (!user || !passwordOk) return null;
  const totpOk = await verifyTotp({ token: credentials.totp, secret: user.totp_secret });
  if (!totpOk.valid) return null;
  return { user_id: user.user_id };
};
