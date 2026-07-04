import { newId, Offer } from '@merited/contracts';
import { CoreHttpError } from '../../http-error.js';
import type { OffersRepository } from './repository.js';

export type OfferDraftInput = Omit<Offer, 'offer_id' | 'status'>;

/**
 * Offers CRUD service (CORE-2, B3/§5.1): create/update draft, pause, end,
 * list, get. Publishing and the COR lifecycle arrive with CORE-5 (they call
 * the trio); nothing here touches commitments.
 */
export class OffersService {
  constructor(private readonly repository: OffersRepository) {}

  async createDraft(input: OfferDraftInput): Promise<Offer> {
    const offer = Offer.parse({ ...input, offer_id: newId('off'), status: 'draft' });
    await this.repository.insert(offer);
    return offer;
  }

  /** Offers stay freely editable until ended (§2.2 — only bounty changes
   * cycle the COR, and those go through CORE-5's editBounty). */
  async update(offerId: string, patch: Partial<OfferDraftInput>): Promise<Offer> {
    const existing = await this.get(offerId);
    if (existing.status === 'ended') {
      throw new CoreHttpError(409, 'OFFER_ENDED', 'an ended offer cannot be edited');
    }
    const next = Offer.parse({ ...existing, ...patch, offer_id: offerId, status: existing.status });
    await this.repository.update(next);
    return next;
  }

  async pause(offerId: string): Promise<void> {
    await this.get(offerId); // 404 before 409
    if (!(await this.repository.setStatus(offerId, 'paused', ['live']))) {
      throw new CoreHttpError(409, 'OFFER_NOT_LIVE', 'only a live offer can be paused');
    }
  }

  async end(offerId: string): Promise<void> {
    await this.get(offerId);
    if (!(await this.repository.setStatus(offerId, 'ended', ['draft', 'live', 'paused']))) {
      throw new CoreHttpError(409, 'OFFER_ENDED', 'offer is already ended');
    }
  }

  async get(offerId: string): Promise<Offer> {
    const record = await this.repository.get(offerId);
    if (!record) throw new CoreHttpError(404, 'OFFER_NOT_FOUND');
    return record.offer;
  }

  async list(filter: { merchantId?: string; status?: Offer['status'] } = {}): Promise<Offer[]> {
    return this.repository.list(filter);
  }
}
