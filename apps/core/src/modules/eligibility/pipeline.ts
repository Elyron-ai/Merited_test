import type {
  CommitmentStatus,
  EligibilityResult,
  EligibilityRule,
  EligibleOffer,
  IdentityTier,
  Segment,
} from '@merited/contracts';
import { ruleExcludes } from './exclusions.js';
import { dedupeStacking } from './stacking.js';

/**
 * The full §5.4 fixed-order filter chain (PH1-3, B6 full): liveness → tier
 * → commitment liveness + cap → stacking-group dedupe (best consumer
 * value, tie-break by offer_id) → merchant exclusion rules. PURE and
 * deterministic — all IO (commitment statuses, rules) is fetched by the
 * caller and passed in as data; first failure wins per offer; every
 * excluded offer carries a machine-readable reason.
 *
 * Phase-0 callers that pass no agent/segment/rules get the identical
 * Phase-0 behaviour: the exclusion stage no-ops on an empty rule set.
 */
export interface EligibilityInput {
  tier: IdentityTier;
  /** Injected clock value (§4: no ambient time inside stage functions). */
  now: Date;
  /** Trio commitment statuses, batched by the caller (CORE-11 wires HTTP). */
  commitmentStatuses: ReadonlyMap<string, CommitmentStatus>;
  /** PH1-3: exclusion-rule context — the read path supplies all three. */
  agentId?: string | null;
  segment?: Segment;
  rules?: readonly EligibilityRule[];
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

  // 4 — stacking-group dedupe (PH1-3: best consumer value wins; ties break
  // stable by offer_id — see stacking.ts).
  const { kept, deduped } = dedupeStacking(eligible);
  for (const candidate of deduped) {
    excluded.push({ offer_id: candidate.offer.offer_id, reason: 'STACKING_DEDUPED' });
  }

  // 5 — merchant exclusion rules (PH1-3: the data-driven stage).
  const rules = input.rules ?? [];
  const survivors: EligibleOffer[] = [];
  for (const candidate of kept) {
    const ctx = {
      agentId: input.agentId ?? null,
      tier: input.tier,
      segment: input.segment ?? 't3-acquisition', // degraded read default (§5.3)
    };
    if (rules.some((rule) => ruleExcludes(rule, candidate.offer, ctx))) {
      excluded.push({ offer_id: candidate.offer.offer_id, reason: 'MERCHANT_EXCLUDED' });
      continue;
    }
    survivors.push(candidate);
  }

  return { eligible: survivors, excluded };
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
