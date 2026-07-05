import type { DecisionCtx, Decisioner, EligibleOffer, RankedOffer } from '@merited/contracts';
import { consumerValueScore } from '../eligibility/stacking.js';

/**
 * RulesDecisioner v1 (PH1-4, B7/§5.5) — deterministic hand rules, no ML
 * anywhere (§5.5's hard rule; the Phase-2 sidecar implements the same
 * interface over HTTP). Rank order:
 *
 *  1. merchant priority (injected config, higher first — the ops knob);
 *  2. margin-aware: bounty-bearing offers first (a live COR means platform
 *     revenue on conversion — display-only offers carry none);
 *  3. consumer value at the reference price (better deal converts better —
 *     shared scorer with stacking, SYN-13's one pricing function);
 *  4. tie-break stable by `offer_id`.
 *
 * The exposed `score` is decisioner-internal colour (contracts marks it
 * optional); ordering is the contract.
 */
export interface RulesDecisionerOptions {
  /** merchant_id → priority; unlisted merchants rank 0. */
  merchantPriority?: Readonly<Record<string, number>>;
}

export class RulesDecisioner implements Decisioner {
  constructor(private readonly options: RulesDecisionerOptions = {}) {}

  async rank(eligible: EligibleOffer[], _ctx: DecisionCtx): Promise<RankedOffer[]> {
    const priority = (candidate: EligibleOffer): number =>
      this.options.merchantPriority?.[candidate.offer.merchant_id] ?? 0;
    const scored = eligible.map((candidate) => ({
      candidate,
      priority: priority(candidate),
      bounty: candidate.commitment_id !== null ? 1 : 0,
      value: consumerValueScore(candidate.offer),
    }));
    scored.sort(
      (a, b) =>
        b.priority - a.priority ||
        b.bounty - a.bounty ||
        b.value - a.value ||
        (a.candidate.offer.offer_id < b.candidate.offer.offer_id ? -1 : 1),
    );
    return scored.map(({ candidate, priority: p, bounty, value }) => ({
      ...candidate,
      score: p * 1_000_000 + bounty * 100_000 + value,
    }));
  }
}
