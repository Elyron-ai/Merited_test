import { createECDH, randomBytes } from 'node:crypto';
import { NotificationPayload, newId } from '@merited/contracts';
import { verifyChain } from '@merited/events';
import webpush from 'web-push';
import { type FastifyInstance } from 'fastify';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrate } from '../../../../../packages/events/scripts/migrate.mjs';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — plain-JS script module
import { migrateWallet } from '../../../scripts/migrate.mjs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmtpMailer } from '../../lib/mailer/smtp.js';
import { buildWalletServer } from '../../server.js';
import { CapturingPushTransport, PushService } from './push.js';
import { generateVapidKeys, vapidFromEnv } from './vapid.js';

/**
 * PH1-17 accept: payload validates against `NotificationPayload`;
 * `NotificationSent` lands in the ledger; the deep link resolves to the
 * correct quote; CI captures and asserts the payload WITHOUT a real browser
 * push service (capturing transport for content; the real `web-push` wire
 * proven against a local fake push endpoint).
 */
const ADMIN = 'postgres://merited_admin:merited_dev@localhost:5432/merited';
const dbName = `merited_push_${Date.now().toString(36)}`;
const VAPID = { ...generateVapidKeys(), subject: 'mailto:push-test@merited.test' };
const money = (amount: number) => ({ amount, currency: 'GBP_pence' as const });

let admin: pg.Client;
let pool: pg.Pool;
let consumerRef: string;

/** A browser-shaped subscription: P-256 uncompressed public key + 16-byte auth. */
const fakeBrowserSubscription = (endpoint: string) => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    endpoint,
    keys: {
      p256dh: ecdh.getPublicKey().toString('base64url'),
      auth: randomBytes(16).toString('base64url'),
    },
  };
};

const QUOTE = {
  quote_id: newId('qte'),
  offer_title: 'Full spa day — Aurora Club price',
  merchant_name: 'Aurora Experiences',
  final: money(7183),
  expires_at: new Date(Date.now() + 14 * 60_000).toISOString(),
};

beforeAll(async () => {
  admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName} OWNER merited_migrate`);
  const migrateUrl = `postgres://merited_migrate:merited_migrate_dev@localhost:5432/${dbName}`;
  await migrate(migrateUrl);
  await migrateWallet(migrateUrl);
  pool = new pg.Pool({
    connectionString: `postgres://merited_app:merited_app_dev@localhost:5432/${dbName}`,
    max: 5,
  });
  pool.on('error', () => {});
  consumerRef = newId('usr');
  await pool.query(`INSERT INTO wallet.consumers (consumer_ref, email) VALUES ($1, 'push@test.co.uk')`, [consumerRef]);
});

afterAll(async () => {
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

describe('web push (PH1-17)', () => {
  it('send-on-quote: CI captures the payload; it validates against the contract; deep link → the correct quote', async () => {
    const transport = new CapturingPushTransport();
    const push = new PushService({ pool, transport, vapid: VAPID, clock: { now: () => new Date() } });

    await push.register(consumerRef, fakeBrowserSubscription('https://push.example/sub-1'));
    await push.register(consumerRef, fakeBrowserSubscription('https://push.example/sub-2'));

    const sent = await push.sendQuoteNotification(consumerRef, QUOTE);
    expect(sent.delivered).toBe(2); // fanned out to every subscription

    // the CAPTURED payload (what the browser would receive) validates
    expect(transport.deliveries).toHaveLength(2);
    const captured = JSON.parse(transport.deliveries[0]!.payload) as NotificationPayload;
    expect(NotificationPayload.parse(captured)).toEqual(captured);
    expect(captured.quote.quote_id).toBe(QUOTE.quote_id);
    expect(captured.title).toContain('£71.83');
    expect(captured.body).toMatch(/Expires in 1[34] minutes/);
    // deep link resolves to the approval screen for the SAME quote
    expect(captured.deep_link).toBe(`/approve/${QUOTE.quote_id}`);
  });

  it('NotificationSent lands in the hash-chained ledger and the chain verifies', async () => {
    const { rows } = await pool.query<{ body: { data: { quote_id: string; consumer_ref: string } } }>(
      `SELECT body FROM events.events WHERE type = 'NotificationSent' ORDER BY seq DESC LIMIT 1`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body.data.quote_id).toBe(QUOTE.quote_id);
    expect(rows[0]!.body.data.consumer_ref).toBe(consumerRef);
    const client = await pool.connect();
    try {
      expect((await verifyChain(client)).ok).toBe(true);
    } finally {
      client.release();
    }
  });

  it('a dead subscription (410 Gone) is pruned; delivery continues to the rest', async () => {
    const deadConsumer = newId('usr');
    await pool.query(`INSERT INTO wallet.consumers (consumer_ref, email) VALUES ($1, 'dead@test.co.uk')`, [deadConsumer]);
    const transport = new (class extends CapturingPushTransport {
      override async deliver(delivery: Parameters<CapturingPushTransport['deliver']>[0]): Promise<void> {
        if (delivery.subscription.endpoint.includes('dead')) {
          throw Object.assign(new Error('gone'), { statusCode: 410 });
        }
        await super.deliver(delivery);
      }
    })();
    const push = new PushService({ pool, transport, vapid: VAPID, clock: { now: () => new Date() } });
    await push.register(deadConsumer, fakeBrowserSubscription('https://push.example/dead-sub'));
    await push.register(deadConsumer, fakeBrowserSubscription('https://push.example/live-sub'));

    const sent = await push.sendQuoteNotification(deadConsumer, { ...QUOTE, quote_id: newId('qte') });
    expect(sent.delivered).toBe(1); // the live one
    const remaining = await pool.query<{ endpoint: string }>(
      `SELECT endpoint FROM wallet.push_subscriptions WHERE consumer_ref = $1`,
      [deadConsumer],
    );
    expect(remaining.rows.map((r) => r.endpoint)).toEqual(['https://push.example/live-sub']);
  });

  it('the REAL web-push wire: VAPID-signed, aes128gcm-encrypted request (no push service needed)', () => {
    // webpush.generateRequestDetails is the exact request builder
    // sendNotification uses — this exercises the real library's VAPID signing
    // (RFC 8292) + payload encryption (RFC 8291) with no network at all.
    const payload = JSON.stringify({ ping: true });
    const subscription = fakeBrowserSubscription('https://push.example/wp/one');
    const details = webpush.generateRequestDetails(subscription, payload, {
      vapidDetails: { subject: VAPID.subject, publicKey: VAPID.publicKey, privateKey: VAPID.privateKey },
      TTL: 300,
    });
    expect(details.method).toBe('POST');
    expect(details.endpoint).toBe(subscription.endpoint);
    expect(String(details.headers['Authorization'])).toMatch(/^vapid t=.+k=.+/); // RFC 8292 VAPID auth
    expect(details.headers['Content-Encoding']).toBe('aes128gcm'); // RFC 8291 — payload never travels in clear
    expect(String(details.headers['TTL'])).toBe('300');
    const body = details.body as Buffer;
    expect(body.length).toBeGreaterThan(payload.length); // ciphertext + salt + key material
    expect(body.toString('utf8')).not.toContain('ping'); // genuinely encrypted
  });

  it('vapidFromEnv fails fast on missing vars and loads a complete set', () => {
    expect(() => vapidFromEnv({} as NodeJS.ProcessEnv)).toThrow(/MERITED_VAPID/);
    const loaded = vapidFromEnv({
      MERITED_VAPID_PUBLIC_KEY: VAPID.publicKey,
      MERITED_VAPID_PRIVATE_KEY: VAPID.privateKey,
      MERITED_VAPID_SUBJECT: 'mailto:ops@merited.test',
    } as NodeJS.ProcessEnv);
    expect(loaded.publicKey).toBe(VAPID.publicKey);
    expect(loaded.subject).toBe('mailto:ops@merited.test');
  });
});

describe('push routes require a session (PH1-17, authn on every route)', () => {
  let app: FastifyInstance;
  let baseUrl: string;

  beforeAll(async () => {
    app = buildWalletServer({
      pool,
      mailer: new SmtpMailer({ host: 'localhost', port: 1025, from: 'noreply@merited.test' }),
      sessionSecret: 'push-route-secret',
      verifyBaseUrl: 'https://wallet.merited.test/verify',
      vapid: VAPID,
      pushTransport: new CapturingPushTransport(),
    });
    baseUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await app.close();
  });

  it('no cookie → 401 on subscription registration', async () => {
    expect((await fetch(`${baseUrl}/v1/push/subscriptions`, { method: 'POST' })).status).toBe(401);
  });
});
