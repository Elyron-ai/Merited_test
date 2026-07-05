import type { GuardrailCtx, GuardrailInputs, Guardrails, Money, Offer, RankedOffer } from '@merited/contracts';
import { applyGuardrails } from './rules.js';

/**
 * Guardrails implementations behind the one contracts interface (B8).
 * `NoopGuardrails` is the Phase-0 stub (kept for tests); `RuleGuardrails`
 * (PH2-1) is the real thing — inert for unconfigured merchants, so it is
 * the safe assembly default.
 */
export class NoopGuardrails implements Guardrails {
  apply(
    ranked: RankedOffer[],
    _ctx: GuardrailCtx,
  ): { passed: RankedOffer[]; suppressed: Array<{ offer_id: string; reason: string }> } {
    return { passed: ranked, suppressed: [] };
  }
}

export class RuleGuardrails implements Guardrails {
  constructor(private readonly listPriceFor: (offer: Offer) => Money) {}

  apply(
    ranked: RankedOffer[],
    _ctx: GuardrailCtx,
    inputs?: GuardrailInputs,
  ): { passed: RankedOffer[]; suppressed: Array<{ offer_id: string; reason: string }> } {
    if (!inputs) return { passed: ranked, suppressed: [] }; // no facts, no rules
    return applyGuardrails(ranked, inputs, this.listPriceFor);
  }
}

export { applyGuardrails, isPointsDenominated, lambdaBps, marginCostBps } from './rules.js';
