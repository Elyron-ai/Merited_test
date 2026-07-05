import {
  applyMechanics,
  type GuardrailInputs,
  type GuardrailSettings,
  type Money,
  type OfferMechanics,
  type RankedOffer,
} from '@merited/contracts';

/**
 * B8 guardrails, the real rules (PH2-1, §5.6) — POST-DECISION and strictly
 * DETERMINISTIC: pure functions of the ranked list, the merchant's guardrail
 * settings, live commitment counters and the read's clock. Unconfigured
 * merchants pass everything (enabling a rule is data, never a deploy).
 *
 * Order of checks per offer: budget exhaustion FIRST (baseline, never
 * config-gated — §5.6's Accept is unconditional: an exhausted budget cannot
 * pay its bounty, so the offer is never shown) → brand denylist → margin
 * ceiling; then ONE list-level pass — when any merchant's pacing λ is
 * below its threshold, that merchant's points-denominated offers re-rank
 * ahead of its priced offers (stable within groups): points are the
 * cheapest currency (§5.6).
 */
export const POINTS_MECHANICS_PREFIX = 'points_';

export const isPointsDenominated = (mechanics: OfferMechanics): boolean =>
  mechanics.type.startsWith(POINTS_MECHANICS_PREFIX);

/** Price give-away in basis points of list: (list − final) / list. */
export const marginCostBps = (list: Money, mechanics: OfferMechanics): number => {
  if (list.amount <= 0) return 0;
  const { final } = applyMechanics(list, mechanics);
  return Math.floor(((list.amount - final.amount) * 10000) / list.amount);
};

/**
 * Budget-pacing λ in basis points: 10000 · (remaining/reference) ÷
 * time_remaining_fraction. Interpretation: λ = 10000 means the budget is
 * burning exactly on pace; below the merchant's threshold means the budget
 * is running hot for the time left, so prefer the cheapest currency.
 * Null when unconfigured or the commitment carries no budget (no pacing).
 */
export const lambdaBps = (input: {
  budgetRemaining: Money | null;
  referenceBudgetPence: number;
  validFrom: string;
  validUntil: string;
  now: Date;
}): number | null => {
  if (!input.budgetRemaining) return null;
  const total = Date.parse(input.validUntil) - Date.parse(input.validFrom);
  if (total <= 0) return null;
  const remainingMs = Date.parse(input.validUntil) - input.now.getTime();
  const timeFraction = Math.min(1, Math.max(0.01, remainingMs / total));
  const budgetFraction = input.budgetRemaining.amount / input.referenceBudgetPence;
  return Math.floor((10000 * budgetFraction) / timeFraction);
};

const denylisted = (
  offer: RankedOffer['offer'],
  denylist: NonNullable<GuardrailSettings['denylist']>,
): boolean => {
  if (!denylist) return false;
  const haystack = `${offer.title} ${offer.description}`.toLowerCase();
  if (denylist.terms.some((term) => term && haystack.includes(term.toLowerCase()))) return true;
  const scope = offer.sku_scope;
  if (
    Array.isArray(scope) &&
    denylist.categories.some((category) => scope.includes(category))
  ) {
    return true;
  }
  return false;
};

export interface GuardrailVerdict {
  passed: RankedOffer[];
  suppressed: Array<{ offer_id: string; reason: string }>;
}

export const applyGuardrails = (
  ranked: RankedOffer[],
  inputs: GuardrailInputs,
  listPriceFor: (offer: RankedOffer['offer']) => Money,
): GuardrailVerdict => {
  const suppressed: Array<{ offer_id: string; reason: string }> = [];
  const passed: RankedOffer[] = [];
  /** merchants whose pacing λ fell below threshold during this read */
  const lowLambdaMerchants = new Set<string>();

  for (const candidate of ranked) {
    // 1 · budget exhaustion — BASELINE, applies to every merchant with or
    // without guardrail config (§5.6 Accept): a spent budget cannot pay, so
    // the read flips to no_offer rather than minting doomed quotes.
    const status = candidate.commitment_id ? inputs.statuses[candidate.commitment_id] : null;
    if (status?.budget_remaining && status.budget_remaining.amount <= 0) {
      suppressed.push({ offer_id: candidate.offer.offer_id, reason: 'BUDGET_EXHAUSTED' });
      continue;
    }

    const settings = inputs.settings[candidate.offer.merchant_id] ?? null;
    if (!settings) {
      passed.push(candidate);
      continue;
    }

    // 2 · brand rules — denylist categories/terms
    if (settings.denylist && denylisted(candidate.offer, settings.denylist)) {
      suppressed.push({ offer_id: candidate.offer.offer_id, reason: 'BRAND_DENYLIST' });
      continue;
    }

    // 3 · margin floor — offer cost must not exceed the configured ceiling
    if (settings.margin_ceiling_bps !== null && settings.margin_ceiling_bps !== undefined) {
      const cost = marginCostBps(listPriceFor(candidate.offer), candidate.offer.mechanics);
      if (cost > settings.margin_ceiling_bps) {
        suppressed.push({ offer_id: candidate.offer.offer_id, reason: 'MARGIN_CEILING_EXCEEDED' });
        continue;
      }
    }

    // 4 · budget pacing λ (payable offers with live counters only)
    if (settings.pacing && status) {
      const lambda = lambdaBps({
        budgetRemaining: status.budget_remaining,
        referenceBudgetPence: settings.pacing.reference_budget_pence,
        validFrom: candidate.offer.valid_from,
        validUntil: candidate.offer.valid_until,
        now: inputs.now,
      });
      if (lambda !== null && lambda < settings.pacing.lambda_threshold_bps) {
        lowLambdaMerchants.add(candidate.offer.merchant_id);
      }
    }

    passed.push(candidate);
  }

  // 5 · points-preference under low λ: a stable partition per affected
  // merchant — points-denominated first, priced after; order within each
  // group is preserved (deterministic re-rank, §5.6)
  if (lowLambdaMerchants.size > 0) {
    const points = passed.filter(
      (c) => lowLambdaMerchants.has(c.offer.merchant_id) && isPointsDenominated(c.offer.mechanics),
    );
    const rest = passed.filter(
      (c) => !(lowLambdaMerchants.has(c.offer.merchant_id) && isPointsDenominated(c.offer.mechanics)),
    );
    return { passed: [...points, ...rest], suppressed };
  }
  return { passed, suppressed };
};
