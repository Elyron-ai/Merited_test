/**
 * FakeAurora's user directory (PH1-10). The brand owns its members — the IdP
 * authenticates them and, on consent, releases scope-gated claims. `sub` is
 * STABLE per member (an OIDC requirement) and matches the seed's member_ref
 * so a linked account resolves the same identity end to end (VAL-9's
 * sub_hashes are sha256('aurora-club:'+member_ref); the wallet re-derives).
 */
export interface AuroraIdpMember {
  /** Stable OIDC subject — the seeded member_ref. */
  sub: string;
  /** Login handle for the consent screen (fake password: 'aurora'). */
  username: string;
  name: string;
  loyalty_tier: 'Member' | 'Gold';
  points_balance: number;
  status: 'active' | 'revoked';
}

export const AURORA_IDP_MEMBERS: readonly AuroraIdpMember[] = [
  { sub: 'am_seed_ada', username: 'ada', name: 'Ada Aurora', loyalty_tier: 'Member', points_balance: 1250, status: 'active' },
  { sub: 'am_seed_bea', username: 'bea', name: 'Bea Aurora', loyalty_tier: 'Member', points_balance: 340, status: 'active' },
  { sub: 'am_seed_cyn', username: 'cyn', name: 'Cyn Aurora', loyalty_tier: 'Gold', points_balance: 8900, status: 'active' },
  { sub: 'am_seed_dev', username: 'dev', name: 'Dev Aurora', loyalty_tier: 'Gold', points_balance: 5600, status: 'active' },
  { sub: 'am_seed_eve', username: 'eve', name: 'Eve Aurora', loyalty_tier: 'Gold', points_balance: 0, status: 'revoked' },
] as const;

export const memberByUsername = (username: string): AuroraIdpMember | undefined =>
  AURORA_IDP_MEMBERS.find((m) => m.username === username);

export const memberBySub = (sub: string): AuroraIdpMember | undefined =>
  AURORA_IDP_MEMBERS.find((m) => m.sub === sub);

/** Scope-gated claims (§6.2 scopes: profile / balance / tier). */
export const claimsForScopes = (member: AuroraIdpMember, scopes: readonly string[]): Record<string, unknown> => {
  const claims: Record<string, unknown> = { sub: member.sub };
  if (scopes.includes('profile')) claims['name'] = member.name;
  if (scopes.includes('balance')) claims['points_balance'] = member.points_balance;
  if (scopes.includes('tier')) claims['loyalty_tier'] = member.loyalty_tier;
  return claims;
};
