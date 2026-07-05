import { randomUUID } from 'node:crypto';
import {
  EligibilityRule,
  type EligibleOffer,
  type IdentityTier,
  type MeritedId,
  type Segment,
} from '@merited/contracts';
import type pg from 'pg';

/**
 * Merchant exclusion rules (PH1-3, §5.4's one data-driven stage). Pure
 * matching here; rows live in `core.eligibility_rules` via `RulesStore`.
 * A rule DENIES: any match excludes the offer as MERCHANT_EXCLUDED.
 */
export interface ExclusionCtx {
  agentId: string | null;
  tier: IdentityTier;
  segment: Segment;
}

export const ruleExcludes = (
  rule: EligibilityRule,
  offer: EligibleOffer['offer'],
  ctx: ExclusionCtx,
): boolean => {
  if (rule.merchant_id !== offer.merchant_id) return false;
  switch (rule.type) {
    case 'merchant_agent_exclusion':
      return ctx.agentId !== null && rule.agent_id === ctx.agentId;
    case 'merchant_tier_exclusion':
      return (
        (rule.tier !== null && rule.tier === ctx.tier) ||
        (rule.segment !== null && rule.segment === ctx.segment)
      );
    case 'merchant_sku_exclusion':
      return offer.sku_scope === 'all' || offer.sku_scope.includes(rule.sku_ref);
  }
};

/** `core.eligibility_rules` access (config rows — creatable and deletable
 * from the control-plane authoring screen). */
/** Omit distributed over the union so each variant keeps its shape. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type EligibilityRuleDraft = DistributiveOmit<EligibilityRule, 'rule_id' | 'created_at'> & {
  rule_id?: string;
  created_at?: string;
};

export class RulesStore {
  constructor(private readonly pool: pg.Pool) {}

  async list(merchantId?: MeritedId<'mer'>): Promise<EligibilityRule[]> {
    const { rows } = merchantId
      ? await this.pool.query<{ body: unknown }>(
          `SELECT body FROM core.eligibility_rules WHERE merchant_id = $1 ORDER BY rule_id`,
          [merchantId],
        )
      : await this.pool.query<{ body: unknown }>(
          `SELECT body FROM core.eligibility_rules ORDER BY rule_id`,
        );
    return rows.map((row) => EligibilityRule.parse(row.body));
  }

  async add(rule: EligibilityRuleDraft): Promise<EligibilityRule> {
    const full = EligibilityRule.parse({
      rule_id: rule.rule_id ?? `elr_${randomUUID()}`,
      created_at: rule.created_at ?? new Date().toISOString(),
      ...rule,
    });
    await this.pool.query(
      `INSERT INTO core.eligibility_rules (rule_id, merchant_id, body) VALUES ($1, $2, $3::jsonb)`,
      [full.rule_id, full.merchant_id, JSON.stringify(full)],
    );
    return full;
  }

  async remove(ruleId: string): Promise<boolean> {
    const result = await this.pool.query(`DELETE FROM core.eligibility_rules WHERE rule_id = $1`, [
      ruleId,
    ]);
    return (result.rowCount ?? 0) > 0;
  }
}
