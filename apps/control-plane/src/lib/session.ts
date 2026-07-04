import { randomBytes } from 'node:crypto';
import type pg from 'pg';

const SESSION_TTL_S = 12 * 60 * 60;

/**
 * Sessions exist ONLY after full authentication (§5.7). `createSession`
 * always mints a fresh random id and never adopts a presented cookie —
 * session fixation is impossible by construction (tested).
 */
export const createSession = async (pool: pg.Pool, userId: string): Promise<string> => {
  const sessionId = randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO control_plane.sessions (session_id, user_id, expires_at)
     VALUES ($1, $2, now() + interval '${SESSION_TTL_S} seconds')`,
    [sessionId, userId],
  );
  return sessionId;
};

export const validateSession = async (
  pool: pg.Pool,
  sessionId: string,
): Promise<{ user_id: string; email: string } | null> => {
  const { rows } = await pool.query<{ user_id: string; email: string }>(
    `SELECT s.user_id, u.email FROM control_plane.sessions s
       JOIN control_plane.users u ON u.user_id = s.user_id
      WHERE s.session_id = $1 AND s.expires_at > now()`,
    [sessionId],
  );
  return rows[0] ?? null;
};

export const destroySession = async (pool: pg.Pool, sessionId: string): Promise<void> => {
  await pool.query(`DELETE FROM control_plane.sessions WHERE session_id = $1`, [sessionId]);
};
