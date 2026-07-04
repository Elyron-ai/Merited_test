import type {
  CommitmentStatus,
  EligibilityResult,
  EligibleOffer,
  IdentityTier,
} from '@merited/contracts';

/**
 * Eligibility, Phase-0 minimal (CORE-6, B6/§5.4) — PURE deterministic
 * filters in FIXED order: liveness → tier → commitment+cap → stacking
 * dedupe. First failure wins per offer; stacking applies only among
 * survivors. All IO (commitment statuses from the trio's SYN-7 read
 * endpoint) is fetched up front and passed in as data. Ph1's merchant
 * exclusions/richer stacking replace the policy INSIDE these steps
 * (CORE-P1-2) — the shape is final.
 */
export interface EligibilityInput {
  tier: IdentityTier;
  /** Injected clock value (§4: no ambient time inside stage functions). */
  now: Date;
  /** Trio commitment statuses, batched by the caller (CORE-11 wires HTTP). */
  commitmentStatuses: ReadonlyMap<string, CommitmentStatus>;
}

export const filterEligibility = (
  candidates: readonly EligibleOffer[],
  input: EligibilityInput,
): EligibilityResult => {
  const eligible: EligibleOffer[] = [];
  const excluded: EligibilityResult['excluded'] = [];
  const nowMs = input.now.getTime();

  for (const candidate of candidates) {
    const { offer } = candidate;

    // 1 — offer liveness (SYN-37: OFFER_NOT_LIVE)
    const inWindow =
      nowMs >= Date.parse(offer.valid_from) && nowMs <= Date.parse(offer.valid_until);
    if (offer.status !== 'live' || !inWindow) {
      excluded.push({ offer_id: offer.offer_id, reason: 'OFFER_NOT_LIVE' });
      continue;
    }

    // 2 — tier
    if (!offer.identity_tiers.includes(input.tier)) {
      excluded.push({ offer_id: offer.offer_id, reason: 'TIER_INELIGIBLE' });
      continue;
    }

    // 3 — commitment liveness + cap (bounty-bearing offers only). An
    // unknown status is excluded conservatively: an unverifiable promise
    // is not shown (the trio is the source of truth, SYN-7).
    if (candidate.commitment_id !== null) {
      const status = input.commitmentStatuses.get(candidate.commitment_id);
      if (!status || status.status !== 'live') {
        excluded.push({ offer_id: offer.offer_id, reason: 'COMMITMENT_ENDED' });
        continue;
      }
      if (status.max_conversions !== null && status.conversions_used >= status.max_conversions) {
        excluded.push({ offer_id: offer.offer_id, reason: 'CAP_EXHAUSTED' });
        continue;
      }
    }

    eligible.push(candidate);
  }

  // 4 — stacking-group dedupe: one offer per non-null group; the Ph0
  // winner is the lowest offer_id (stable and deterministic; Ph1's
  // stacking rules replace this policy inside the same step).
  const winners = new Map<string, string>();
  for (const candidate of eligible) {
    const group = candidate.offer.stacking_group;
    if (group === null) continue;
    const current = winners.get(group);
    if (current === undefined || candidate.offer.offer_id < current) {
      winners.set(group, candidate.offer.offer_id);
    }
  }
  const deduped = eligible.filter((candidate) => {
    const group = candidate.offer.stacking_group;
    if (group === null || winners.get(group) === candidate.offer.offer_id) return true;
    excluded.push({ offer_id: candidate.offer.offer_id, reason: 'STACKING_DEDUPED' });
    return false;
  });

  return { eligible: deduped, excluded };
};

/** Batch the trio status reads for stage 3 (one call per DISTINCT COR). */
export const fetchCommitmentStatuses = async (
  candidates: readonly EligibleOffer[],
  statusFor: (commitmentId: string) => Promise<CommitmentStatus | null>,
): Promise<Map<string, CommitmentStatus>> => {
  const ids = [...new Set(candidates.flatMap((c) => (c.commitment_id ? [c.commitment_id] : [])))];
  const statuses = await Promise.all(ids.map(async (id) => [id, await statusFor(id)] as const));
  return new Map(
    statuses.flatMap(([id, status]) => (status ? [[id, status] as const] : [])),
  );
};
