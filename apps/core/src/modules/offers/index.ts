// Offers storage + CRUD (CORE-2), publish/COR lifecycle (CORE-5).
export { OffersRepository, type OfferRecord } from './repository.js';
export { OffersService, type OfferDraftInput } from './service.js';
export { offers, offerCounters, offerCommitments } from './schema.js';
export { OfferPublisher, type BountyInput, type PublisherDeps } from './publisher.js';
export { TrioCommitmentsClient, type CommitmentIssuer } from './trio-commitments-client.js';
