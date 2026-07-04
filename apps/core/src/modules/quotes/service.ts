import {
  applyMechanics,
  newId,
  OfferQuote,
  type AgentCtx,
  type IdentityTier,
  type MeritedId,
  type MintResult,
  type MintRequest,
  type Money,
  type Offer,
  type RankedOffer,
  type Segment,
} from '@merited/contracts';
import { appendEvent } from '@merited/events';
import type pg from 'pg';
import { inTx } from '../../db.js';
import { CoreHttpError } from '../../http-error.js';

/** §2.3: tokens live ≤ 10 minutes — the mint-request snapshot is clamped to
 * this bound up front, then expires_at clamps AGAIN to the actual claims.exp. */
const TOKEN_TTL_BOUND_S = 600;

export interface QuoteCtx {
  agent: AgentCtx;
  tier: IdentityTier;
  segment: Segment;
  consumer_ref?: MeritedId<'usr'> | null;
  session_nonce?: string;
  /** SKU list-price source (MER-11's fixture module, wired by CORE-11). */
  listPriceFor(offer: Offer): Money;
}

export interface QuoteMinter {
  mint(request: MintRequest): Promise<MintResult>;
}

export interface QuotesDeps {
  pool: pg.Pool;
  tokenClient: QuoteMinter;
  /** MERITED_QUOTE_TTL_S, resolved by the caller's env loader (default 900). */
  quoteTtlS?: number;
  clock?: { now(): Date };
}

const isoS = (date: Date): string => date.toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Quote Service (CORE-10, B24/§5.6a). Quotes are priced promises, not
 * reservations — no inventory holds. Every COR-backed offer in a read
 * persists EXACTLY ONE quote row (payable or not — anonymous reads persist
 * with token: null so quote ids stay honest); display-only offers (no COR)
 * are not quoted. A failed mint never drops the quote: it ships unpayable.
 */
export class QuoteService {
  private readonly ttlS: number;
  private readonly clock: { now(): Date };

  constructor(private readonly deps: QuotesDeps) {
    this.ttlS = deps.quoteTtlS ?? 900;
    this.clock = deps.clock ?? { now: () => new Date() };
  }

  async issueQuotes(finalOffers: RankedOffer[], ctx: QuoteCtx): Promise<OfferQuote[]> {
    const quotes: OfferQuote[] = [];
    for (const ranked of finalOffers) {
      if (ranked.commitment_id === null) continue; // display-only, nothing promised
      quotes.push(await this.issueOne(ranked.offer, ranked.commitment_id, ctx));
    }
    return quotes;
  }

  private async issueOne(
    offer: Offer,
    commitmentId: MeritedId<'com'>,
    ctx: QuoteCtx,
  ): Promise<OfferQuote> {
    const list = ctx.listPriceFor(offer);
    const { final, mechanics_applied } = applyMechanics(list, offer.mechanics);
    const quoteId = newId('qte');
    const createdAt = this.clock.now();
    const provisionalExpS =
      Math.floor(createdAt.getTime() / 1000) + Math.min(this.ttlS, TOKEN_TTL_BOUND_S);
    let expiresAt = new Date(provisionalExpS * 1000);
    let token: string | null = null;
    let tokenJti: string | null = null;

    if (ctx.agent.agent_id !== null) {
      const minted = await this.deps.tokenClient.mint({
        cid: commitmentId,
        qid: quoteId,
        aid: ctx.agent.agent_id,
        tier: ctx.tier,
        session_nonce: ctx.session_nonce ?? quoteId,
        quote: { expires_at: isoS(expiresAt), mandate_ref: null },
      });
      if (minted.ok) {
        token = minted.minted.token;
        tokenJti = minted.minted.claims.jti;
        // §3 invariant: expires_at always ≤ token exp.
        const expS = Math.min(provisionalExpS, minted.minted.claims.exp);
        expiresAt = new Date(expS * 1000);
      }
      // a failed mint leaves the quote unpayable rather than dropped (CORE-9)
    }

    const quote = OfferQuote.parse({
      quote_id: quoteId,
      offer_id: offer.offer_id,
      commitment_id: commitmentId,
      agent_id: ctx.agent.agent_id,
      consumer_ref: ctx.consumer_ref ?? null,
      tier: ctx.tier,
      segment: ctx.segment,
      price: { list, final, mechanics_applied },
      token,
      expires_at: isoS(expiresAt),
    });

    const inputsSnapshot = {
      offer, // version + mechanics as shown
      identity: { tier: ctx.tier, segment: ctx.segment, consumer_ref: ctx.consumer_ref ?? null },
      eligibility: { commitment_id: commitmentId },
      pricing: { list, final, mechanics_applied },
    };

    await inTx(this.deps.pool, async (tx) => {
      await tx.query(
        `INSERT INTO core.quotes
           (quote_id, offer_id, commitment_id, agent_id, consumer_ref, tier, segment,
            list_amount, final_amount, currency, mechanics_applied, token_jti,
            expires_at, created_at, inputs_snapshot)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15::jsonb)`,
        [
          quote.quote_id,
          quote.offer_id,
          quote.commitment_id,
          quote.agent_id,
          quote.consumer_ref,
          quote.tier,
          quote.segment,
          list.amount,
          final.amount,
          'GBP_pence',
          JSON.stringify(mechanics_applied),
          tokenJti,
          quote.expires_at,
          isoS(createdAt),
          JSON.stringify(inputsSnapshot),
        ],
      );
      await appendEvent(tx, 'QuoteIssued', {
        quote_id: quote.quote_id,
        offer_id: quote.offer_id,
        commitment_id: quote.commitment_id,
        agent_id: quote.agent_id,
        consumer_ref: quote.consumer_ref,
        tier: quote.tier,
        segment: quote.segment,
        price: quote.price,
        token_jti: tokenJti,
        expires_at: quote.expires_at,
      });
    });
    return quote;
  }

  /** Audit read: the persisted quote row + its inputs snapshot. */
  async getQuote(quoteId: string): Promise<{
    quote_id: string;
    offer_id: string;
    commitment_id: string;
    final_amount: number;
    list_amount: number;
    token_jti: string | null;
    agent_id: string | null;
    expires_at: string;
    inputs_snapshot: unknown;
  }> {
    const { rows } = await this.deps.pool.query(
      `SELECT quote_id, offer_id, commitment_id, list_amount, final_amount,
              token_jti, agent_id, expires_at, inputs_snapshot
         FROM core.quotes WHERE quote_id = $1`,
      [quoteId],
    );
    if (!rows[0]) throw new CoreHttpError(404, 'QUOTE_NOT_FOUND');
    const row = rows[0] as {
      quote_id: string;
      offer_id: string;
      commitment_id: string;
      list_amount: number;
      final_amount: number;
      token_jti: string | null;
      agent_id: string | null;
      expires_at: Date;
      inputs_snapshot: unknown;
    };
    return { ...row, expires_at: isoS(row.expires_at) };
  }

  /** Latest claim intake for a quote (SYN-40): how the QUOTE'S OWNER — the
   * agent — discovers its verdict without ever learning the claim id out of
   * band. Rejected replays land newer rows for the same qid, so LATEST is
   * the poller's answer. Returns null while no claim has arrived. */
  async latestClaimFor(quoteId: string): Promise<{
    claim_id: string;
    verdict: 'pending' | 'verified' | 'rejected';
    reason_code: string | null;
    entries_preview: unknown | null;
  } | null> {
    const { rows } = await this.deps.pool.query(
      `SELECT claim_id, verdict, reason_code, entries_preview FROM core.claims_intake
        WHERE qid = $1 ORDER BY created_at DESC, claim_id DESC LIMIT 1`,
      [quoteId],
    );
    return (
      (rows[0] as {
        claim_id: string;
        verdict: 'pending' | 'verified' | 'rejected';
        reason_code: string | null;
        entries_preview: unknown | null;
      } | undefined) ?? null
    );
  }

  /** Quotes are promises: live until expiry, converted when the ledger says so. */
  async getQuoteStatus(quoteId: string): Promise<'live' | 'expired' | 'converted'> {
    const quote = await this.getQuote(quoteId);
    const converted = await this.deps.pool.query(
      `SELECT 1 FROM events.events
        WHERE type = 'ConversionVerified' AND body->'data'->>'qid' = $1 LIMIT 1`,
      [quoteId],
    );
    if (converted.rows.length > 0) return 'converted';
    return this.clock.now().getTime() > Date.parse(quote.expires_at) ? 'expired' : 'live';
  }
}
