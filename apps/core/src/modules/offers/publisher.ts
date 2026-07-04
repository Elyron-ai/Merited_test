import {
  CommitmentDraft,
  type Commitment,
  type Merchant,
  type MeritedId,
  type Money,
  type Offer,
} from '@merited/contracts';
import { appendEvent } from '@merited/events';
import type pg from 'pg';
import { inTx } from '../../db.js';
import { CoreHttpError } from '../../http-error.js';
import type { CommitmentIssuer } from './trio-commitments-client.js';
import type { OffersRepository } from './repository.js';

export interface PublisherDeps {
  pool: pg.Pool;
  repository: OffersRepository;
  commitments: CommitmentIssuer;
  merchantFor(merchantId: MeritedId<'mer'>): Promise<Merchant>;
}

export interface BountyInput {
  bounty: CommitmentDraft['bounty'];
  max_conversions?: number | null;
  budget?: Money | null;
}

const isoNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Offer publish flow + bounty-edit COR lifecycle (CORE-5, B3/§5.1).
 * Publishing a bounty-bearing offer creates the COR FIRST (trio emits
 * `CommitmentCreated`); only then does the offer go live and `OfferPublished`
 * land in the ledger — a failed trio call leaves the offer untouched.
 * Offers stay freely editable; ONLY bounty changes cycle the COR
 * (arch §2.2 "no retroactive repricing": the old COR is ended, never
 * edited, and its in-flight tokens still verify — SYN-34).
 */
export class OfferPublisher {
  constructor(private readonly deps: PublisherDeps) {}

  private async draftFor(offer: Offer, merchant: Merchant, input: BountyInput): Promise<CommitmentDraft> {
    // explicit null = "no budget"; undefined falls back to the merchant default
    const budget =
      input.budget === null ? null : (input.budget ?? merchant.commercial.budgets.per_offer_default);
    return CommitmentDraft.parse({
      merchant_id: offer.merchant_id,
      offer_ref: offer.offer_id,
      bounty: input.bounty,
      take_rate_bps: merchant.commercial.take_rate_bps,
      agent_commission_bps: merchant.commercial.agent_commission_bps,
      terms: {
        attribution_window_s: merchant.commercial.attribution_window_s,
        eligible_identity_tiers: offer.identity_tiers,
        max_conversions: input.max_conversions ?? null,
        clawback_window_s: merchant.commercial.clawback_window_s,
        valid_from: offer.valid_from,
        valid_until: offer.valid_until,
      },
      ...(budget ? { budget } : {}),
    });
  }

  /** Publish: draft/paused → live; with a bounty, countersigned by the trio. */
  async publish(offerId: string, bountyInput?: BountyInput): Promise<{ offer_id: string; commitment_id: string | null }> {
    const record = await this.deps.repository.get(offerId);
    if (!record) throw new CoreHttpError(404, 'OFFER_NOT_FOUND');
    const { offer } = record;
    if (offer.status !== 'draft' && offer.status !== 'paused') {
      throw new CoreHttpError(409, 'OFFER_NOT_PUBLISHABLE', `status is ${offer.status}`);
    }

    let commitment: Commitment | null = null;
    if (bountyInput) {
      const merchant = await this.deps.merchantFor(offer.merchant_id);
      commitment = await this.deps.commitments.create(await this.draftFor(offer, merchant, bountyInput));
    }

    await inTx(this.deps.pool, async (tx) => {
      await tx.query(
        `UPDATE core.offers SET status = 'live', current_commitment_id = $2, updated_at = now()
          WHERE offer_id = $1`,
        [offer.offer_id, commitment?.commitment_id ?? null],
      );
      if (commitment) {
        await tx.query(
          `INSERT INTO core.offer_commitments (offer_id, commitment_id) VALUES ($1, $2)`,
          [offer.offer_id, commitment.commitment_id],
        );
      }
      await appendEvent(tx, 'OfferPublished', {
        offer_id: offer.offer_id,
        merchant_id: offer.merchant_id,
        commitment_id: commitment?.commitment_id ?? null,
        published_at: isoNow(),
      });
    });
    return { offer_id: offer.offer_id, commitment_id: commitment?.commitment_id ?? null };
  }

  /** Bounty edit: end the old COR, mint a new one, repoint — history kept. */
  async editBounty(offerId: string, input: BountyInput): Promise<{ old_commitment_id: string; commitment_id: string }> {
    const record = await this.deps.repository.get(offerId);
    if (!record) throw new CoreHttpError(404, 'OFFER_NOT_FOUND');
    if (record.offer.status === 'ended') {
      throw new CoreHttpError(409, 'OFFER_ENDED', 'an ended offer cannot be repriced');
    }
    const oldCommitmentId = record.current_commitment_id;
    if (!oldCommitmentId) {
      throw new CoreHttpError(409, 'NO_COMMITMENT', 'offer has no bounty commitment to edit');
    }

    const merchant = await this.deps.merchantFor(record.offer.merchant_id);
    await this.deps.commitments.end(oldCommitmentId, 'bounty repriced');
    const next = await this.deps.commitments.create(
      await this.draftFor(record.offer, merchant, input),
    );

    await inTx(this.deps.pool, async (tx) => {
      await tx.query(
        `UPDATE core.offers SET current_commitment_id = $2, updated_at = now() WHERE offer_id = $1`,
        [offerId, next.commitment_id],
      );
      await tx.query(
        `UPDATE core.offer_commitments SET ended_at = now()
          WHERE offer_id = $1 AND commitment_id = $2 AND ended_at IS NULL`,
        [offerId, oldCommitmentId],
      );
      await tx.query(
        `INSERT INTO core.offer_commitments (offer_id, commitment_id) VALUES ($1, $2)`,
        [offerId, next.commitment_id],
      );
    });
    return { old_commitment_id: oldCommitmentId, commitment_id: next.commitment_id };
  }
}
