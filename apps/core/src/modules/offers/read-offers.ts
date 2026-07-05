import {
  OfferReadResponse,
  type AgentCtx,
  type CommitmentStatus,
  type ConsumerCtx,
  type Decisioner,
  type Guardrails,
  type Money,
  type Offer,
} from '@merited/contracts';
import { withSpan } from '@merited/otel';
import { fetchCommitmentStatuses, filterEligibility } from '../eligibility/filter.js';
import { resolve, type Clock } from '../identity/resolve.js';
import type { IdentityStore } from '../identity/store.js';
import type { QuoteService } from '../quotes/service.js';
import type { OffersRepository } from './repository.js';

export interface ReadOffersQuery {
  merchant_id?: string;
  sku?: string;
  /** Ph0 text search: plain ILIKE over title/description (§11 restraint). */
  text?: string;
  /** Single-offer pass (`GET /v1/offers/:id` — a fresh quote every call). */
  offer_id?: string;
}

export interface ReadOffersInput {
  agent: AgentCtx;
  consumer?: ConsumerCtx;
  query: ReadOffersQuery;
}

export interface ReadOffersDeps {
  repository: OffersRepository;
  identity: IdentityStore;
  decisioner: Decisioner;
  guardrails: Guardrails;
  quotes: QuoteService;
  clock: Clock;
  commitmentStatusFor(commitmentId: string): Promise<CommitmentStatus | null>;
  listPriceFor(offer: Offer): Money;
  /** PH1-3: merchant exclusion rules — absent means no rules (Phase-0). */
  rulesStore?: { list(): Promise<import('@merited/contracts').EligibilityRule[]> };
  /** Structured analytics sink (B19 consumes in Ph1) — pino-compatible. */
  logger?: { info(payload: Record<string, unknown>, message: string): void };
}

/**
 * `readOffers()` (CORE-11, B9/§4) — THE one internal function every surface
 * wraps. Stage order exactly: candidates → resolveIdentity →
 * filterEligibility → decisioning.rank → guardrails.apply → quote (mint
 * inside the quote stage, CORE-10). One OTel span per stage, all children
 * of one trace (§8: one trace ID from readOffers to the ledger — the demo
 * asset's backbone). Excluded/suppressed offers are recorded with reason
 * codes for analytics (B19 consumes in Phase 1).
 */
export class ReadOffers {
  constructor(private readonly deps: ReadOffersDeps) {}

  /**
   * `check_eligibility` (PH1-6, SYN-26): per-offer verdicts + exclusion
   * reasons, NO quotes and NO minting — the same candidate → identity →
   * filter path `read()` uses, stopped before decisioning. Offers not
   * among the candidates come back `eligible:false` (unknown / not live).
   */
  async checkEligibility(input: {
    agent: AgentCtx;
    consumer?: ConsumerCtx;
    offerIds: readonly string[];
  }): Promise<{ results: Array<{ offer_id: string; eligible: boolean; reason?: string }> }> {
    const candidates = await this.deps.repository.listCandidates({});
    const wanted = new Set(input.offerIds);
    const scoped = candidates.filter((c) => wanted.has(c.offer.offer_id));
    const lookups = await this.deps.identity.lookupsFor(input.consumer);
    const identity = resolve(input.consumer, lookups, this.deps.clock);
    const statuses = await fetchCommitmentStatuses(scoped, (cid) =>
      this.deps.commitmentStatusFor(cid),
    );
    const rules = (await this.deps.rulesStore?.list()) ?? [];
    const result = filterEligibility(scoped, {
      tier: identity.tier,
      now: this.deps.clock.now(),
      commitmentStatuses: statuses,
      agentId: input.agent.agent_id,
      segment: identity.segment,
      rules,
    });
    const eligibleIds = new Set<string>(result.eligible.map((e) => e.offer.offer_id));
    const reasonById = new Map<string, string>(result.excluded.map((e) => [e.offer_id, e.reason]));
    return {
      results: input.offerIds.map((offer_id) => {
        if (eligibleIds.has(offer_id)) return { offer_id, eligible: true };
        const reason = reasonById.get(offer_id);
        // an offer id we never saw as a candidate is unknown → not live
        return { offer_id, eligible: false, reason: reason ?? 'OFFER_NOT_LIVE' };
      }),
    };
  }

  async read(input: ReadOffersInput): Promise<OfferReadResponse> {
    return withSpan('read_offers', async (root) => {
      root.setAttribute('agent.anonymous', input.agent.agent_id === null);

      const candidates = await withSpan('read_offers.candidates', async (span) => {
        const found = await this.deps.repository.listCandidates({
          ...(input.query.merchant_id ? { merchantId: input.query.merchant_id } : {}),
          ...(input.query.sku ? { sku: input.query.sku } : {}),
          ...(input.query.text ? { text: input.query.text } : {}),
          ...(input.query.offer_id ? { offerId: input.query.offer_id } : {}),
        });
        span.setAttribute('candidates.count', found.length);
        return found;
      });

      const identity = await withSpan('read_offers.resolve_identity', async (span) => {
        const lookups = await this.deps.identity.lookupsFor(input.consumer);
        const resolved = resolve(input.consumer, lookups, this.deps.clock);
        span.setAttribute('identity.tier', resolved.tier);
        span.setAttribute('identity.segment', resolved.segment);
        return resolved;
      });

      const eligibility = await withSpan('read_offers.filter_eligibility', async (span) => {
        const statuses = await fetchCommitmentStatuses(candidates, (cid) =>
          this.deps.commitmentStatusFor(cid),
        );
        const rules = (await this.deps.rulesStore?.list()) ?? [];
        const result = filterEligibility(candidates, {
          tier: identity.tier,
          now: this.deps.clock.now(),
          commitmentStatuses: statuses,
          agentId: input.agent.agent_id,
          segment: identity.segment,
          rules,
        });
        span.setAttribute('eligible.count', result.eligible.length);
        span.setAttribute(
          'excluded.reasons',
          result.excluded.map((e) => `${e.offer_id}:${e.reason}`),
        );
        if (result.excluded.length > 0) {
          this.deps.logger?.info({ excluded: result.excluded }, 'offers excluded at eligibility');
        }
        return result;
      });

      const ctx = { agent: input.agent, tier: identity.tier, segment: identity.segment };

      const ranked = await withSpan('read_offers.decisioning', (span) =>
        this.deps.decisioner.rank(eligibility.eligible, ctx).then((result) => {
          span.setAttribute('ranked.count', result.length);
          return result;
        }),
      );

      const passed = await withSpan('read_offers.guardrails', async (span) => {
        const result = this.deps.guardrails.apply(ranked, ctx);
        span.setAttribute('suppressed.count', result.suppressed.length);
        if (result.suppressed.length > 0) {
          this.deps.logger?.info({ suppressed: result.suppressed }, 'offers suppressed by guardrails');
        }
        return result.passed;
      });

      const quotes = await withSpan('read_offers.quote', async (span) => {
        const issued = await this.deps.quotes.issueQuotes(passed, {
          agent: input.agent,
          tier: identity.tier,
          segment: identity.segment,
          consumer_ref: input.consumer?.consumer_ref ?? null,
          listPriceFor: this.deps.listPriceFor,
        });
        span.setAttribute('quotes.count', issued.length);
        span.setAttribute('quotes.payable', issued.filter((q) => q.token !== null).length);
        return issued;
      });

      return OfferReadResponse.parse({
        quotes,
        ...(input.agent.agent_id === null
          ? { hint: { register_to_earn: true, register_url: '/v1/agents/register' } }
          : {}),
      });
    });
  }
}
