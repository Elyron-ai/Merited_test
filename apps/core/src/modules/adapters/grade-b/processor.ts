import {
  VerifyResponse,
  type ConversionClaim,
  type FakeShopOrderWebhook,
  type Merchant,
} from '@merited/contracts';
import { appendEvent } from '@merited/events';
import { injectTraceparent } from '@merited/otel';
import type { Signer } from '@merited/signing';
import type pg from 'pg';
import { inTx } from '../../../db.js';
import { buildSignedClaim, decodeTokenClaims } from './claim-builder.js';
import { normaliseOrder } from './normalise.js';
import type { OrderProcessor } from './routes.js';

export interface GradeBProcessorDeps {
  pool: pg.Pool;
  signer: Signer;
  trioBaseUrl: string;
  trioServiceToken: string;
  timeoutMs?: number;
  logger?: {
    info(payload: Record<string, unknown>, message: string): void;
    warn(payload: Record<string, unknown>, message: string): void;
  };
}

/**
 * The MER-4 pipeline behind MER-3's intake: normalise → build + sign claim
 * (custodied key via the Signer interface) → `ConversionClaimed` into the
 * ledger → `POST /trio/claims/verify` → persist verdict in `claims_intake`.
 *
 * P2/SYN-5: a token-less order is ordinary non-agent commerce — dropped
 * with a structured log, NO claim, NO ledger event, 200 to the shop (not
 * an error; retrying would not grow a token).
 */
export class GradeBOrderProcessor implements OrderProcessor {
  constructor(private readonly deps: GradeBProcessorDeps) {}

  async processOrder(
    payload: FakeShopOrderWebhook,
    merchant: Merchant,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const order = normaliseOrder(payload);
    if (!order.token) {
      this.deps.logger?.info(
        { merchant_slug: merchant.slug, order_ref_hash: order.order_ref_hash, reason: 'TOKEN_ABSENT' },
        'token-less order dropped (no claim, no ledger event)',
      );
      return { status: 200, body: { outcome: 'ignored', reason: 'TOKEN_ABSENT' } };
    }
    if (!merchant.signing_key_ref) {
      return { status: 409, body: { error: { code: 'NO_SIGNING_KEY' } } };
    }

    const claim = await buildSignedClaim(
      { ...order, token: order.token },
      { merchant_id: merchant.merchant_id, signing_key_ref: merchant.signing_key_ref },
      this.deps.signer,
    );

    // ConversionClaimed carries the token's decoded refs — metadata only,
    // trust stays with the trio. An undecodable token still gets submitted
    // (the trio answers SIG_INVALID; both sides see why).
    const tokenClaims = decodeTokenClaims(order.token);
    await inTx(this.deps.pool, async (tx) => {
      if (tokenClaims) {
        await appendEvent(tx, 'ConversionClaimed', {
          claim_id: claim.claim_id,
          merchant_id: merchant.merchant_id,
          jti: tokenClaims.jti,
          qid: tokenClaims.qid,
          cid: tokenClaims.cid,
          order_ref_hash: claim.order.order_ref_hash,
          gross_value: claim.order.gross_value,
          ts: claim.order.ts,
        });
      }
      await tx.query(
        `INSERT INTO core.claims_intake (claim_id, merchant_id, order_ref_hash, gross_pence, jti, qid, cid)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          claim.claim_id,
          merchant.merchant_id,
          claim.order.order_ref_hash,
          claim.order.gross_value.amount,
          tokenClaims?.jti ?? null,
          tokenClaims?.qid ?? null,
          tokenClaims?.cid ?? null,
        ],
      );
    });

    const verdict = await this.submitToTrio(claim);
    await this.deps.pool.query(
      `UPDATE core.claims_intake SET verdict = $2, reason_code = $3, updated_at = now()
        WHERE claim_id = $1`,
      [
        claim.claim_id,
        verdict.verdict,
        verdict.verdict === 'rejected' ? verdict.reason_code : null,
      ],
    );

    return {
      status: 200,
      body: {
        claim_id: claim.claim_id,
        verdict: verdict.verdict,
        ...(verdict.verdict === 'rejected' ? { reason_code: verdict.reason_code } : {}),
      },
    };
  }

  private async submitToTrio(claim: ConversionClaim): Promise<VerifyResponse> {
    const response = await fetch(`${this.deps.trioBaseUrl}/trio/claims/verify`, {
      method: 'POST',
      headers: injectTraceparent({
        'content-type': 'application/json',
        'x-merited-service-token': this.deps.trioServiceToken,
        'idempotency-key': claim.claim_id, // claim ids are fresh per intake; trio replays byte-stable
      }),
      body: JSON.stringify(claim),
      signal: AbortSignal.timeout(this.deps.timeoutMs ?? 5000),
    });
    if (response.status !== 200) {
      throw new Error(`trio verify responded ${response.status}`);
    }
    return VerifyResponse.parse(await response.json());
  }
}
