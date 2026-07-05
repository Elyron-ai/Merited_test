import formbody from '@fastify/formbody';
import { createHash } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { AURORA_IDP_MEMBERS } from '../idp/members.js';

/**
 * FakeAurora loyalty API (PH1-11, B27). The brand's own points system:
 * member lookup, tier, balance, and an idempotent points-credit endpoint
 * (Act 2 step 6 credits points on a verified conversion). In-memory state
 * seeded from the member directory — a demo/test brand backend, not a
 * production loyalty engine. `LoyaltyLookup` (core) wraps this over HTTP.
 */
interface LoyaltyServerOptions {
  serviceToken?: string;
}

export interface FakeAuroraLoyalty {
  app: FastifyInstance;
  listen(): Promise<string>;
  close(): Promise<void>;
  /** Test/introspection helper — the live balance for a member. */
  balanceOf(memberRef: string): number | null;
}

export const createFakeAuroraLoyalty = async (
  options: LoyaltyServerOptions = {},
): Promise<FakeAuroraLoyalty> => {
  const balances = new Map<string, { tier: string; balance: number }>();
  for (const member of AURORA_IDP_MEMBERS) {
    const record = { tier: member.loyalty_tier, balance: member.points_balance };
    balances.set(member.sub, record);
    // B23-friendly reference: the brand can derive its own members' privacy
    // handles, so credits keyed by sub_hash resolve to the SAME record —
    // OIDC-linked wallets never need the raw member reference (PH2-10/11).
    balances.set(createHash('sha256').update(`aurora-club:${member.sub}`).digest('hex'), record);
    balances.set(createHash('sha256').update(member.sub).digest('hex'), record);
  }
  const seenOrders = new Set<string>(); // idempotency per order_ref_hash

  const app = Fastify();
  await app.register(formbody);

  if (options.serviceToken) {
    app.addHook('onRequest', async (req, reply) => {
      if (req.headers['x-merited-service-token'] !== options.serviceToken) {
        await reply.code(401).send({ error: 'unauthorised' });
      }
    });
  }

  app.get('/loyalty/members/:ref', async (req, reply) => {
    const ref = (req.params as { ref: string }).ref;
    const member = balances.get(ref);
    if (!member) return reply.code(404).send({ error: 'not_found' });
    return { member_ref: ref, tier: member.tier, balance: member.balance };
  });

  app.post('/loyalty/credit', async (req, reply) => {
    const body = req.body as { member_ref?: string; points?: number; order_ref_hash?: string };
    if (!body.member_ref || typeof body.points !== 'number' || !body.order_ref_hash) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const member = balances.get(body.member_ref);
    if (!member) return reply.code(404).send({ error: 'not_found' });
    // idempotent per order: a repeat credit for the same order is a no-op
    if (!seenOrders.has(body.order_ref_hash)) {
      seenOrders.add(body.order_ref_hash);
      member.balance += body.points;
    }
    return { member_ref: body.member_ref, balance: member.balance };
  });

  return {
    app,
    listen: () => app.listen({ port: 0, host: '127.0.0.1' }),
    close: () => app.close(),
    balanceOf: (ref) => balances.get(ref)?.balance ?? null,
  };
};
