import argon2 from 'argon2';
import { generate as generateTotp } from 'otplib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateControlPlane } from '../scripts/migrate.mjs';
import { authenticate } from '../src/lib/auth';
import { isPublicPath, signSessionId, verifySessionCookie } from '../src/lib/cookie-sign';
import { createSession, destroySession, validateSession } from '../src/lib/session';

const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_cp_${Date.now().toString(36)}`;
const TOTP_SECRET = 'GC6LROIAXSRZCWQ4FAH3K2SURHRZH7A2';
const SECRET = 'test-session-secret';

let admin: pg.Client;
let pool: pg.Pool;

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  await migrateControlPlane(`postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 5,
  });
  pool.on('error', () => {});
  await pool.query(
    `INSERT INTO control_plane.users (user_id, email, password_hash, totp_secret)
     VALUES ('usr_00TESTADM1N000000000000001', 'admin@merited.test', $1, $2)`,
    [await argon2.hash('correct-horse', { type: argon2.argon2id }), TOTP_SECRET],
  );
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('control-plane auth (MER-7 accept)', () => {
  it('correct password + live TOTP authenticates; WRONG TOTP is rejected', async () => {
    const good = await authenticate(pool, {
      email: 'admin@merited.test',
      password: 'correct-horse',
      totp: await generateTotp({ secret: TOTP_SECRET }),
    });
    expect(good).toEqual({ user_id: 'usr_00TESTADM1N000000000000001' });

    const wrongTotp = await authenticate(pool, {
      email: 'admin@merited.test',
      password: 'correct-horse',
      totp: '000000',
    });
    expect(wrongTotp).toBeNull();
  });

  it('wrong password and unknown email fail with the SAME uniform null (no oracle)', async () => {
    expect(
      await authenticate(pool, { email: 'admin@merited.test', password: 'wrong', totp: '000000' }),
    ).toBeNull();
    expect(
      await authenticate(pool, { email: 'nobody@merited.test', password: 'x', totp: '000000' }),
    ).toBeNull();
  });

  it('session fixation is impossible by construction: login mints a FRESH id; a presented id never authenticates', async () => {
    // the attacker plants a session id of their choosing before login
    const planted = 'attacker-chosen-session-id';
    expect(await validateSession(pool, planted)).toBeNull();

    // the victim logs in — the session id is newly minted, never adopted
    const sessionId = await createSession(pool, 'usr_00TESTADM1N000000000000001');
    expect(sessionId).not.toBe(planted);
    expect(await validateSession(pool, sessionId)).toMatchObject({ email: 'admin@merited.test' });

    // the planted id STILL opens nothing
    expect(await validateSession(pool, planted)).toBeNull();

    // and logout really ends the session
    await destroySession(pool, sessionId);
    expect(await validateSession(pool, sessionId)).toBeNull();
  });

  it('expired sessions do not validate', async () => {
    const sessionId = await createSession(pool, 'usr_00TESTADM1N000000000000001');
    // the runtime role holds no UPDATE on sessions — nudge the clock as the
    // schema owner, on THIS test database
    const owner = new pg.Client({
      connectionString: `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`,
    });
    await owner.connect();
    try {
      await owner.query(
        `UPDATE control_plane.sessions SET expires_at = now() - interval '1 second' WHERE session_id = $1`,
        [sessionId],
      );
    } finally {
      await owner.end();
    }
    expect(await validateSession(pool, sessionId)).toBeNull();
  });

  it('cookie signatures verify and tampering is rejected', async () => {
    const signed = await signSessionId('some-session', SECRET);
    expect(await verifySessionCookie(signed, SECRET)).toBe('some-session');
    expect(await verifySessionCookie(signed.replace(/.$/, '0'), SECRET)).toBeNull();
    expect(await verifySessionCookie(`other-session.${signed.split('.')[1]}`, SECRET)).toBeNull();
    expect(await verifySessionCookie(signed, 'different-secret')).toBeNull();
  });

  it('only the login surfaces and static assets are public', () => {
    expect(isPublicPath('/login')).toBe(true);
    expect(isPublicPath('/api/login')).toBe(true);
    expect(isPublicPath('/_next/static/x.js')).toBe(true);
    expect(isPublicPath('/')).toBe(false);
    expect(isPublicPath('/merchants')).toBe(false);
    expect(isPublicPath('/api/anything')).toBe(false);
  });
});
