import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import argon2 from 'argon2';
import { generate as generateTotp } from 'otplib';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateControlPlane } from '../scripts/migrate.mjs';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_cpe2e_${Date.now().toString(36)}`;
const TOTP_SECRET = 'GC6LROIAXSRZCWQ4FAH3K2SURHRZH7A2';
const SESSION_SECRET = 'e2e-session-secret';
const PORT = 3900 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;

let admin: pg.Client;
let server: ChildProcess | null = null;

const get = (pathname: string, cookie?: string) =>
  fetch(`${BASE}${pathname}`, {
    redirect: 'manual',
    headers: cookie ? { cookie } : {},
  });

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  await migrateControlPlane(`postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`);
  const pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 2,
  });
  await pool.query(
    `INSERT INTO control_plane.users (user_id, email, password_hash, totp_secret)
     VALUES ('usr_00TESTADM1N000000000000001', 'admin@merited.test', $1, $2)`,
    [await argon2.hash('correct-horse', { type: argon2.argon2id }), TOTP_SECRET],
  );
  await pool.end();

  if (!existsSync(path.join(appRoot, '.next', 'BUILD_ID'))) {
    execSync('pnpm exec next build', { cwd: appRoot, stdio: 'pipe', timeout: 240_000 });
  }
  server = spawn('pnpm', ['exec', 'next', 'start', '-p', String(PORT)], {
    cwd: appRoot,
    env: {
      ...process.env,
      MERITED_DATABASE_URL: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
      CONTROL_PLANE_SESSION_SECRET: SESSION_SECRET,
      NODE_ENV: 'production',
    },
    stdio: 'pipe',
  });
  // wait for readiness
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const probe = await fetch(`${BASE}/login`, { redirect: 'manual' });
      if (probe.status === 200) return;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('next start never became ready');
}, 300_000);

afterAll(async () => {
  server?.kill('SIGTERM');
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('control-plane routes (MER-7 accept — no route renders without a valid session)', () => {
  it('unauthenticated requests to ANY guarded route redirect to /login', async () => {
    for (const pathname of ['/', '/merchants', '/anything/else']) {
      const response = await get(pathname);
      expect([302, 307, 308]).toContain(response.status);
      expect(response.headers.get('location')).toContain('/login');
    }
  });

  it('a forged session cookie is rejected at the door', async () => {
    const response = await get('/', 'merited_cp_session=forged-session-id.deadbeef');
    expect([302, 307, 308]).toContain(response.status);
    expect(response.headers.get('location')).toContain('/login');
  });

  it('the full login flow: credentials + live TOTP → session cookie → the dashboard renders', async () => {
    const form = new URLSearchParams({
      email: 'admin@merited.test',
      password: 'correct-horse',
      totp: await generateTotp({ secret: TOTP_SECRET }),
    });
    const login = await fetch(`${BASE}/api/login`, {
      method: 'POST',
      body: form,
      redirect: 'manual',
    });
    expect(login.status).toBe(303);
    expect(new URL(login.headers.get('location')!).pathname).toBe('/');
    const setCookie = login.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('merited_cp_session=');
    expect(setCookie.toLowerCase()).toContain('httponly');

    const cookie = setCookie.split(';')[0]!;
    const dashboard = await get('/', cookie);
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain('Merited control plane');
  });

  it('wrong TOTP never yields a session', async () => {
    const form = new URLSearchParams({
      email: 'admin@merited.test',
      password: 'correct-horse',
      totp: '000000',
    });
    const login = await fetch(`${BASE}/api/login`, { method: 'POST', body: form, redirect: 'manual' });
    expect(login.status).toBe(303);
    expect(login.headers.get('location')).toContain('/login');
    expect(login.headers.get('set-cookie') ?? '').not.toContain('merited_cp_session=');
  });

  it('secrets are absent from the CLIENT bundles (build-output grep)', () => {
    const staticDir = path.join(appRoot, '.next', 'static');
    const offenders: string[] = [];
    const needles = [
      'aurora-admin-dev', // the seeded dev password
      'GC6LROIAXSRZ', // TOTP secret prefix
      'control-plane-dev-secret', // session-signing default
      'merited_app_dev', // database credentials
      'password_hash',
    ];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js')) {
          const source = readFileSync(full, 'utf8');
          for (const needle of needles) {
            if (source.includes(needle)) offenders.push(`${full}: ${needle}`);
          }
        }
      }
    };
    walk(staticDir);
    expect(offenders).toEqual([]);
  });
});
