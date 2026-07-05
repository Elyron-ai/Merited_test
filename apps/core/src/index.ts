// @merited/core — Core platform monolith (CORE-1 skeleton; §1 module tree).
export { createCoreServer, type CoreServer } from './server.js';
export { loadCoreEnv, type CoreEnv } from './env.js';
export { createCoreDb, type CoreDb } from './db.js';
export { CoreHttpError } from './http-error.js';
export {
  InMemoryRateLimiter,
  RedisRateLimiter,
  type RateLimiterOptions,
  type RedisRateLimiterOptions,
} from './modules/adapters/rate-limiter/index.js';
export { MerchantsService, type CreateMerchantInput, type IssuedWebhookSecret } from './modules/merchants/service.js';
export { TrioKeysClient } from './modules/merchants/trio-keys-client.js';
export { OffersRepository } from './modules/offers/repository.js';
export { OffersService, type OfferDraftInput } from './modules/offers/service.js';
export { OfferPublisher, type BountyInput } from './modules/offers/publisher.js';
export { TrioCommitmentsClient } from './modules/offers/trio-commitments-client.js';
export { TrioTokenClient, type TokenClientOptions } from './modules/token-client/client.js';
export { RulesStore, ruleExcludes, type EligibilityRuleDraft } from './modules/eligibility/exclusions.js';
export { consumerValueScore, dedupeStacking } from './modules/eligibility/stacking.js';
export { RulesDecisioner, decisionerFor } from './modules/decisioning/index.js';
export { FakeAuroraLoyalty } from './modules/adapters/loyalty/fake-aurora.js';
export { StaticTableLoyalty } from './modules/adapters/loyalty/static-table.js';
export { FakeAuroraIdpAdapter } from './modules/adapters/idp/fake-aurora.js';
export { IdpRegistry } from './modules/adapters/idp/registry.js';
export { analyticsProjection, bountyFor } from './modules/analytics/projections/index.js';
export { MintVsClaimMonitor, type MerchantHealth, type MonitorOptions } from './modules/analytics/mint-vs-claim-monitor.js';
export { HeadPublicationJob, type HeadPublicationJobDeps } from './modules/audit/head-publication-job.js';
export { SimulatedPayouts, TrioStatementsClient, settlementPayoutsProjection, type StatementsSource } from './modules/adapters/payouts/simulated.js';
