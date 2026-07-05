import { applyMechanics, pence, type EligibleOffer } from '@merited/contracts';

/**
 * Stacking-group dedupe (PH1-3, §5.4): deterministic winner per
 * `stacking_group` — BEST CONSUMER VALUE, tie-break stable by `offer_id`.
 * Value is measured with the ONE pricing function (SYN-13) at a fixed
 * reference list price, so every mechanics variant lands on one integer
 * scale with no floats and no ambiguity; the same offers always produce
 * the same winner (§5.4's determinism accept).
 */
export const REFERENCE_LIST_PENCE = 10_000; // £100.00

export const consumerValueScore = (offer: EligibleOffer['offer']): number => {
  const { final } = applyMechanics(pence(REFERENCE_LIST_PENCE), offer.mechanics);
  return REFERENCE_LIST_PENCE - final.amount; // pence saved at the reference price
};

export const dedupeStacking = (
  eligible: readonly EligibleOffer[],
): { kept: EligibleOffer[]; deduped: EligibleOffer[] } => {
  const winners = new Map<string, EligibleOffer>();
  for (const candidate of eligible) {
    const group = candidate.offer.stacking_group;
    if (group === null) continue;
    const current = winners.get(group);
    if (!current) {
      winners.set(group, candidate);
      continue;
    }
    const better =
      consumerValueScore(candidate.offer) > consumerValueScore(current.offer) ||
      (consumerValueScore(candidate.offer) === consumerValueScore(current.offer) &&
        candidate.offer.offer_id < current.offer.offer_id);
    if (better) winners.set(group, candidate);
  }
  const kept: EligibleOffer[] = [];
  const deduped: EligibleOffer[] = [];
  for (const candidate of eligible) {
    const group = candidate.offer.stacking_group;
    if (group === null || winners.get(group) === candidate) kept.push(candidate);
    else deduped.push(candidate);
  }
  return { kept, deduped };
};
