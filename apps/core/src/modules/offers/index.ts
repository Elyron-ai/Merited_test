// Offers storage + CRUD (CORE-2), publish/COR lifecycle (CORE-5).
export { OffersRepository, type OfferRecord } from './repository.js';
export { OffersService, type OfferDraftInput } from './service.js';
export { offers, offerCounters, offerCommitments } from './schema.js';
