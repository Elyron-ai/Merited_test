import { pence, type Money, type Offer } from '@merited/contracts';
import { FakeCrypter, FakeSigner } from '@merited/signing';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { InMemoryRateLimiter } from './modules/adapters/rate-limiter/in-memory.js';
import { GradeBOrderProcessor } from './modules/adapters/grade-b/processor.js';
import { registerClaimsRoutes } from './modules/adapters/grade-b/claims-routes.js';
import { registerGradeBWebhook } from './modules/adapters/grade-b/routes.js';
import { AgentsService } from './modules/agents/service.js';
import { decisionerFor } from './modules/decisioning/index.js';
import { NoopGuardrails } from './modules/guardrails/index.js';
import { IdentityStore } from './modules/identity/store.js';
import { MerchantsService } from './modules/merchants/service.js';
import { TrioKeysClient } from './modules/merchants/trio-keys-client.js';
import { OfferPublisher } from './modules/offers/publisher.js';
import { ReadOffers } from './modules/offers/read-offers.js';
import { OffersRepository } from './modules/offers/repository.js';
import { OffersService } from './modules/offers/service.js';
import { TrioCommitmentsClient } from './modules/offers/trio-commitments-client.js';
import { QuoteService } from './modules/quotes/service.js';
import { TrioTokenClient } from './modules/token-client/client.js';
import { registerV1Routes } from './routes/v1/index.js';
import { createCoreServer } from './server.js';

export interface SimulatedCoreOptions {
  /** merited_app URL for a database with events+core (+trio) migrated. */
  databaseUrl: string;
  trioBaseUrl: string;
  trioServiceToken: string;
  signerSecret: string;
  quoteTtlS?: number;
  listPriceFor?(offer: Offer): Money;
  /** PH1-4: registry name (rules | passthrough | random:<seed>); default rules. */
  decisioner?: string;
}

export interface SimulatedCore {
  app: FastifyInstance;
  pool: pg.Pool;
  merchants: MerchantsService;
  agents: AgentsService;
  offers: OffersService;
  repository: OffersRepository;
  publisher: OfferPublisher;
  quotes: QuoteService;
  readOffers: ReadOffers;
  listen(): Promise<string>;
  close(): Promise<void>;
}

/**
 * Full Phase-0 core assembly for consumers that need a RUNNING platform:
 * the CORE-13 SDK suite, CORE-14's gate slice, MER-12's conversion e2e and
 * the demo (VAL-12). Host wiring only — every part is the production
 * module behind its own tests.
 */
export const createSimulatedCore = (options: SimulatedCoreOptions): SimulatedCore => {
  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 10 });
  pool.on('error', () => {});
  const signer = new FakeSigner(options.signerSecret);
  const trioTarget = { baseUrl: options.trioBaseUrl, serviceToken: options.trioServiceToken };

  const repository = new OffersRepository(drizzle(pool));
  const offers = new OffersService(repository);
  const merchants = new MerchantsService(
    pool,
    new FakeCrypter(`${options.signerSecret}-crypter`),
    new TrioKeysClient(trioTarget),
  );
  const commitmentsClient = new TrioCommitmentsClient(trioTarget);
  const publisher = new OfferPublisher({
    pool,
    repository,
    commitments: commitmentsClient,
    merchantFor: (id) => merchants.get(id),
  });
  const agents = new AgentsService(pool);
  const quotes = new QuoteService({
    pool,
    tokenClient: new TrioTokenClient(trioTarget),
    ...(options.quoteTtlS ? { quoteTtlS: options.quoteTtlS } : {}),
  });
  const listPriceFor = options.listPriceFor ?? (() => pence(8450));
  const readOffers = new ReadOffers({
    repository,
    identity: new IdentityStore(pool),
    decisioner: decisionerFor(options.decisioner ?? 'rules'),
    guardrails: new NoopGuardrails(),
    quotes,
    clock: { now: () => new Date() },
    commitmentStatusFor: (cid) => commitmentsClient.status(cid),
    listPriceFor,
  });
  const processor = new GradeBOrderProcessor({
    pool,
    signer,
    trioBaseUrl: options.trioBaseUrl,
    trioServiceToken: options.trioServiceToken,
  });

  const app = createCoreServer();
  registerV1Routes(app, {
    readOffers,
    quotes,
    agents,
    readLimiter: new InMemoryRateLimiter({ limit: 1000, windowS: 3600 }),
    registerLimiter: new InMemoryRateLimiter({ limit: 1000, windowS: 3600 }),
  });
  registerClaimsRoutes(app, {
    pool,
    merchants,
    agents,
    submitter: processor,
    limiter: new InMemoryRateLimiter({ limit: 1000, windowS: 3600 }),
  });
  registerGradeBWebhook(app, {
    pool,
    merchants,
    limiter: new InMemoryRateLimiter({ limit: 1000, windowS: 3600 }),
    processor,
  });

  return {
    app,
    pool,
    merchants,
    agents,
    offers,
    repository,
    publisher,
    quotes,
    readOffers,
    listen: () => app.listen({ port: 0, host: '127.0.0.1' }),
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
};
