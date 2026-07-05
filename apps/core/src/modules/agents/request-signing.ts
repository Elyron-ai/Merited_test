import { createHash, createPublicKey, timingSafeEqual, verify as edVerify } from 'node:crypto';
import {
  AGENT_SIGNATURE_MAX_SKEW_S,
  agentCanonicalString,
  AgentSignatureHeaders,
  type ReplayCache,
} from '@merited/contracts';
import type { Signer } from '@merited/signing';
import type pg from 'pg';

/**
 * Agent request-signature verification (PH1-5, B4 upgrade — HIGH-SCRUTINY,
 * XC.7). Agents hold their OWN Ed25519 keys and register the public half
 * at `core.agent_keys` (CORE-3 reserved the column); verification is
 * against the REGISTERED key only — a valid signature under an
 * unregistered key is a 401, never an enrolment.
 *
 * Order of checks (cheap-and-pure before stateful):
 *   1. header shape (Zod) → canonical string rebuild from the RAW request;
 *   2. timestamp inside ±300s (SYN-24);
 *   3. signature verify — `ed25519:` against the registered public key;
 *      `fake-ed25519:` via the injected FakeSigner ONLY when one is
 *      configured (dev/demo — the env-guarded factory keeps fakes out of
 *      production, PH1-30);
 *   4. nonce replay: ReplayCache seenBefore (records atomically) — a seen
 *      nonce is a 401. Redis is never authoritative for ACCEPTANCE; a dead
 *      cache degrades to timestamp-window-only protection (fail-open on
 *      the cache, fail-closed on everything else).
 */
export interface VerifyRequestSignatureInput {
  method: string;
  pathWithQuery: string;
  rawBody: string;
  headers: Record<string, string | string[] | undefined>;
}

export type SignatureVerdict =
  | { ok: true; agentId: `agt_${string}` }
  | { ok: false; reason: 'MALFORMED' | 'SKEW' | 'SIG_INVALID' | 'NONCE_REPLAYED' | 'KEY_UNREGISTERED' };

export class AgentRequestVerifier {
  constructor(
    private readonly deps: {
      pool: pg.Pool;
      replayCache: ReplayCache;
      clock: { now(): Date };
      /** Dev-only fake path — omit in production (env-guarded factory). */
      fakeSigner?: Signer;
    },
  ) {}

  private async registeredPublicKey(agentId: string): Promise<string | null> {
    const { rows } = await this.deps.pool.query<{ public_key: string | null }>(
      `SELECT public_key FROM core.agent_keys WHERE agent_id = $1 AND public_key IS NOT NULL
        ORDER BY created_at DESC LIMIT 1`,
      [agentId],
    );
    return rows[0]?.public_key ?? null;
  }

  async verify(input: VerifyRequestSignatureInput): Promise<SignatureVerdict> {
    const parsed = AgentSignatureHeaders.safeParse({
      'x-merited-agent-id': input.headers['x-merited-agent-id'],
      'x-merited-timestamp': input.headers['x-merited-timestamp'],
      'x-merited-nonce': input.headers['x-merited-nonce'],
      'x-merited-signature': input.headers['x-merited-signature'],
    });
    if (!parsed.success) return { ok: false, reason: 'MALFORMED' };
    const headers = parsed.data;
    const agentId = headers['x-merited-agent-id'];

    const skew = Math.abs(
      Math.floor(this.deps.clock.now().getTime() / 1000) -
        Number.parseInt(headers['x-merited-timestamp'], 10),
    );
    if (skew > AGENT_SIGNATURE_MAX_SKEW_S) return { ok: false, reason: 'SKEW' };

    const canonical = agentCanonicalString({
      method: input.method,
      pathWithQuery: input.pathWithQuery,
      bodySha256: createHash('sha256').update(input.rawBody, 'utf8').digest('hex'),
      timestamp: headers['x-merited-timestamp'],
      nonce: headers['x-merited-nonce'],
    });
    const signature = headers['x-merited-signature'];

    let signatureOk = false;
    if (signature.startsWith('ed25519:')) {
      const publicKey = await this.registeredPublicKey(agentId);
      if (!publicKey) return { ok: false, reason: 'KEY_UNREGISTERED' };
      try {
        signatureOk = edVerify(
          null,
          Buffer.from(canonical, 'utf8'),
          createPublicKey({
            key: Buffer.from(publicKey.replace(/^ed25519-pub:/, ''), 'base64url'),
            format: 'der',
            type: 'spki',
          }),
          Buffer.from(signature.slice('ed25519:'.length), 'base64url'),
        );
      } catch {
        signatureOk = false;
      }
    } else if (this.deps.fakeSigner) {
      signatureOk = await this.deps.fakeSigner.verify(`agent/${agentId}`, canonical, signature);
    }
    if (!signatureOk) return { ok: false, reason: 'SIG_INVALID' };

    // replay LAST: only a fully valid signature consumes its nonce
    const nonceKey = `agentnonce:${agentId}:${headers['x-merited-nonce']}`;
    if (await this.deps.replayCache.seenBefore(nonceKey, AGENT_SIGNATURE_MAX_SKEW_S * 2)) {
      return { ok: false, reason: 'NONCE_REPLAYED' };
    }
    return { ok: true, agentId };
  }
}

/** Constant-time equality for opaque header secrets (fallback-tier reuse). */
export const timingSafeEqualStrings = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
};
