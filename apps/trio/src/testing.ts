import { FakeSigner } from '@merited/signing';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { CommitmentSimulator, MerchantKeySimulator } from './commitment/simulator.js';
import { registerCommitmentRoutes, registerMerchantKeyRoutes } from './commitment/routes.js';
import { systemClock } from './shared/clock.js';
import { FixtureDirectory, VerifiedDirectory } from './shared/ports/directory.js';
import { createTrioServer } from './shared/server.js';
import { MintSimulator, VerifySimulator } from './verification/simulator.js';
import { registerMintRoutes, registerVerifyRoutes } from './verification/routes.js';
import { SettlementSimulator } from './settlement/simulator.js';
import { registerSettlementRoutes } from './settlement/routes.js';

export interface SimulatedTrioOptions {
  /** merited_app connection URL for a database with events+trio migrated. */
  databaseUrl: string;
  serviceToken: string;
  signerSecret: string;
  /** PH1-24: inject the real Ed25519 signer (PH1-30) — when set,
   * `signerSecret` is unused and every service signs/verifies for real. */
  signer?: import('@merited/signing').Signer;
  /** TRIO-17: the LIVE directory (HttpDirectory against the wallet backend).
   * Absent → the FixtureDirectory, as before. Either way the pipeline sees
   * only the attestation-verifying wrapper. */
  directory?: import('./shared/ports/directory.js').TrioDirectory;
  chromiumPath?: string;
}

export interface SimulatedTrio {
  app: FastifyInstance;
  directory: FixtureDirectory;
  listen(): Promise<string>;
  close(): Promise<void>;
}

/**
 * Full Phase-0 trio assembly (all simulators + routes) for consumers that
 * need a RUNNING trio: CORE-9+ integration tests, the demo, VAL. Additive
 * host wiring only — simulators and the frozen contract suite untouched.
 */
export const createSimulatedTrio = (options: SimulatedTrioOptions): SimulatedTrio => {
  const pool = new pg.Pool({ connectionString: options.databaseUrl, max: 10 });
  pool.on('error', () => {});
  const signer = options.signer ?? new FakeSigner(options.signerSecret);
  const deps = { pool, signer, clock: systemClock };
  const commitments = new CommitmentSimulator(deps);
  const directory = new FixtureDirectory();

  const app = createTrioServer({ serviceToken: options.serviceToken, signer });
  registerCommitmentRoutes(app, commitments);
  registerMerchantKeyRoutes(app, new MerchantKeySimulator(deps));
  registerMintRoutes(app, new MintSimulator(deps, commitments));
  registerVerifyRoutes(app, new VerifySimulator(deps, new VerifiedDirectory(options.directory ?? directory, signer)));
  registerSettlementRoutes(
    app,
    new SettlementSimulator(deps),
    options.chromiumPath ? { chromiumPath: options.chromiumPath } : {},
  );

  return {
    app,
    directory,
    listen: () => app.listen({ port: 0, host: '127.0.0.1' }),
    close: async () => {
      await app.close();
      await pool.end();
    },
  };
};
