import { randomBytes, randomUUID } from 'node:crypto';
import {
  Merchant,
  MerchantCommercial,
  MerchantKeyResponse,
  newId,
  type MeritedId,
} from '@merited/contracts';
import type { Crypter } from '@merited/signing';
import type pg from 'pg';
import { CoreHttpError } from '../../http-error.js';
import { hashKey } from '../agents/keys.js';

const WEBHOOK_SECRET_CRYPTER_REF = 'platform/webhook-secrets';

export interface CreateMerchantInput {
  name: string;
  commercial: MerchantCommercial;
  /** Fixed ID for seed fixtures (VAL-9, D6 — deterministic demo data);
   * omitted everywhere else, where a fresh ULID is generated. */
  merchant_id?: MeritedId<'mer'>;
}

export interface IssuedWebhookSecret {
  secret_id: string;
  /** The plaintext secret — exists in a response exactly once. */
  secret: string;
  secret_last4: string;
}

export interface TrioKeyIssuer {
  issueMerchantKey(merchantId: MeritedId<'mer'>): Promise<MerchantKeyResponse>;
}

const isoS = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

const slugify = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'merchant';

interface MerchantRow {
  merchant_id: MeritedId<'mer'>;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  commercial: unknown;
  signing_key_ref: string | null;
  created_at: Date;
}

const toMerchant = (row: MerchantRow): Merchant =>
  Merchant.parse({
    merchant_id: row.merchant_id,
    name: row.name,
    slug: row.slug,
    status: row.status,
    commercial: row.commercial,
    signing_key_ref: row.signing_key_ref,
    created_at: isoS(row.created_at),
  });

/**
 * Merchants module (MER-2, §5.7). Credential rules: webhook secrets are
 * encrypted at rest via the Crypter port and decrypted ONLY for HMAC
 * verification (SYN-39); API keys are stored as SHA-256 digests (parallel
 * to agent keys); signing keys are custodied by the trio — this module
 * holds references and public halves only. Nothing here writes the ledger
 * (offer publishing emits via CORE-5).
 */
export class MerchantsService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly crypter: Crypter,
    private readonly trioKeys: TrioKeyIssuer,
  ) {}

  async create(input: CreateMerchantInput): Promise<Merchant> {
    const commercial = MerchantCommercial.parse(input.commercial);
    const merchantId = input.merchant_id ?? newId('mer');
    const base = slugify(input.name);
    // uniquify against existing slugs (hand-onboarding scale, §5.7)
    const { rows: taken } = await this.pool.query<{ slug: string }>(
      `SELECT slug FROM core.merchants WHERE slug LIKE $1 || '%'`,
      [base],
    );
    const existing = new Set(taken.map((r) => r.slug));
    let slug = base;
    for (let n = 2; existing.has(slug); n += 1) slug = `${base}-${n}`;

    await this.pool.query(
      `INSERT INTO core.merchants (merchant_id, name, slug, commercial)
       VALUES ($1, $2, $3, $4::jsonb)`,
      [merchantId, input.name, slug, JSON.stringify(commercial)],
    );
    return this.get(merchantId);
  }

  async update(
    merchantId: string,
    patch: Partial<CreateMerchantInput & { status: 'active' | 'suspended' }>,
  ): Promise<Merchant> {
    const current = await this.get(merchantId);
    const commercial = patch.commercial
      ? MerchantCommercial.parse(patch.commercial)
      : current.commercial;
    await this.pool.query(
      `UPDATE core.merchants
          SET name = $2, commercial = $3::jsonb, status = $4, updated_at = now()
        WHERE merchant_id = $1`,
      [merchantId, patch.name ?? current.name, JSON.stringify(commercial), patch.status ?? current.status],
    );
    return this.get(merchantId);
  }

  async get(merchantId: string): Promise<Merchant> {
    const { rows } = await this.pool.query<MerchantRow>(
      `SELECT merchant_id, name, slug, status, commercial, signing_key_ref, created_at
         FROM core.merchants WHERE merchant_id = $1`,
      [merchantId],
    );
    if (!rows[0]) throw new CoreHttpError(404, 'MERCHANT_NOT_FOUND');
    return toMerchant(rows[0]);
  }

  async getBySlug(slug: string): Promise<Merchant> {
    // W11/#35: only ACTIVE merchants resolve by slug. Every caller is a webhook
    // intake rail (grade-B / commerce / protocol), so filtering here makes
    // suspension bite the webhook path exactly as `authenticate()` (m.status =
    // 'active') already makes it bite the agent/merchant API path. A suspended
    // merchant's deliveries now 404, identical to an unknown slug — no oracle.
    const { rows } = await this.pool.query<MerchantRow>(
      `SELECT merchant_id, name, slug, status, commercial, signing_key_ref, created_at
         FROM core.merchants WHERE slug = $1 AND status = 'active'`,
      [slug],
    );
    if (!rows[0]) throw new CoreHttpError(404, 'MERCHANT_NOT_FOUND');
    return toMerchant(rows[0]);
  }

  async list(): Promise<Merchant[]> {
    const { rows } = await this.pool.query<MerchantRow>(
      `SELECT merchant_id, name, slug, status, commercial, signing_key_ref, created_at
         FROM core.merchants ORDER BY merchant_id`,
    );
    return rows.map(toMerchant);
  }

  /** New secret each call; older secrets stay valid until revoked (graceful
   * rotation — MER-3 verifies against every live secret). */
  async issueWebhookSecret(merchantId: string): Promise<IssuedWebhookSecret> {
    await this.get(merchantId);
    const secret = `whsec_${randomBytes(32).toString('base64url')}`;
    const secretId = `whs_${randomUUID()}`;
    const ciphertext = await this.crypter.encrypt(WEBHOOK_SECRET_CRYPTER_REF, secret);
    await this.pool.query(
      `INSERT INTO core.merchant_webhook_secrets (secret_id, merchant_id, secret_ciphertext, secret_last4)
       VALUES ($1, $2, $3, $4)`,
      [secretId, merchantId, ciphertext, secret.slice(-4)],
    );
    return { secret_id: secretId, secret, secret_last4: secret.slice(-4) };
  }

  /** Decrypted live secrets — for the MER-3 HMAC verifier only. */
  async activeWebhookSecrets(merchantId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ secret_ciphertext: string }>(
      `SELECT secret_ciphertext FROM core.merchant_webhook_secrets
        WHERE merchant_id = $1 AND revoked_at IS NULL ORDER BY created_at`,
      [merchantId],
    );
    return Promise.all(
      rows.map((row) => this.crypter.decrypt(WEBHOOK_SECRET_CRYPTER_REF, row.secret_ciphertext)),
    );
  }

  async revokeWebhookSecret(secretId: string): Promise<void> {
    await this.pool.query(
      `UPDATE core.merchant_webhook_secrets SET revoked_at = now() WHERE secret_id = $1`,
      [secretId],
    );
  }

  /** Merchant API key for POST /v1/claims auth (MER-5) — digest stored. */
  async issueApiKey(merchantId: string): Promise<{ key_id: string; api_key: string }> {
    await this.get(merchantId);
    const apiKey = `mmk_${randomBytes(32).toString('base64url')}`;
    const keyId = `mkey_${randomUUID()}`;
    await this.pool.query(
      `INSERT INTO core.merchant_api_keys (key_id, merchant_id, key_hash, key_last4)
       VALUES ($1, $2, $3, $4)`,
      [keyId, merchantId, hashKey(apiKey), apiKey.slice(-4)],
    );
    return { key_id: keyId, api_key: apiKey };
  }

  async authenticate(presentedKey: string): Promise<MeritedId<'mer'> | null> {
    const { rows } = await this.pool.query<{ merchant_id: MeritedId<'mer'> }>(
      `SELECT k.merchant_id
         FROM core.merchant_api_keys k
         JOIN core.merchants m USING (merchant_id)
        WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND m.status = 'active'`,
      [hashKey(presentedKey)],
    );
    return rows[0]?.merchant_id ?? null;
  }

  /** Custodied keypair via the trio (SYN-22): reference + public half only. */
  async requestSigningKey(merchantId: MeritedId<'mer'>): Promise<MerchantKeyResponse> {
    await this.get(merchantId);
    const issued = MerchantKeyResponse.parse(await this.trioKeys.issueMerchantKey(merchantId));
    await this.pool.query(
      `INSERT INTO core.merchant_signing_keys (ref_id, merchant_id, signing_key_ref, public_key)
       VALUES ($1, $2, $3, $4)`,
      [`msk_${randomUUID()}`, merchantId, issued.signing_key_ref, issued.public_key],
    );
    await this.pool.query(
      `UPDATE core.merchants SET signing_key_ref = $2, updated_at = now() WHERE merchant_id = $1`,
      [merchantId, issued.signing_key_ref],
    );
    return issued;
  }
}
