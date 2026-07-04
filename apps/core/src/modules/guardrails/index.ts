import type { GuardrailCtx, Guardrails, RankedOffer } from '@merited/contracts';

/**
 * Guardrails, Phase-0 stub (CORE-7, B8 position): identity pass, nothing
 * suppressed. B8's real rules (margin floor, budget-pacing λ, brand rules)
 * land at CORE-P2-1 behind the same contracts interface.
 */
export class NoopGuardrails implements Guardrails {
  apply(
    ranked: RankedOffer[],
    _ctx: GuardrailCtx,
  ): { passed: RankedOffer[]; suppressed: Array<{ offer_id: string; reason: string }> } {
    return { passed: ranked, suppressed: [] };
  }
}
