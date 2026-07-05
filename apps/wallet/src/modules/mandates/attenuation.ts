import type { Mandate } from '@merited/contracts';

/**
 * Attenuation invariant (PH1-16, §6.1): a child mandate may only ever NARROW
 * its parent — widening any dimension is a validation error by construction.
 * `attenuationViolations` is the pure predicate the service and the property
 * test both use; an empty result means the child is a valid attenuation of the
 * parent (equality is allowed — attenuation is ⊆, not strict ⊂).
 *
 * Every dimension is checked:
 *  - scopes / categories / merchants — child is a SUBSET of the parent's grant
 *    (parent `merchants: ['*']` means "all", so any child merchant list is ⊆);
 *  - per_txn / per_month / pre_authorised_up_to — child amount ≤ parent amount
 *    (and same currency — money is integer pence, never mixed);
 *  - data_sharing — child may not ENABLE a flag the parent left off;
 *  - exp — the child may not outlive the parent.
 */
type Money = Mandate['limits']['per_txn'];

const isSubset = (child: readonly string[], parent: readonly string[]): boolean =>
  child.every((item) => parent.includes(item));

const merchantsSubset = (child: readonly string[], parent: readonly string[]): boolean =>
  parent.includes('*') ? true : !child.includes('*') && isSubset(child, parent);

/** child amount must not exceed parent, and the currency must match. */
const amountWithin = (child: Money, parent: Money): boolean =>
  child.currency === parent.currency && child.amount <= parent.amount;

export const attenuationViolations = (parent: Mandate, child: Mandate): string[] => {
  const violations: string[] = [];
  if (!isSubset(child.scopes, parent.scopes)) violations.push('scopes');
  if (!amountWithin(child.limits.per_txn, parent.limits.per_txn)) violations.push('limits.per_txn');
  if (!amountWithin(child.limits.per_month, parent.limits.per_month)) violations.push('limits.per_month');
  if (!isSubset(child.limits.categories, parent.limits.categories)) violations.push('limits.categories');
  if (!merchantsSubset(child.merchants, parent.merchants)) violations.push('merchants');
  if (!amountWithin(child.pre_authorised_up_to, parent.pre_authorised_up_to)) {
    violations.push('pre_authorised_up_to');
  }
  for (const flag of ['email', 'purchase_history', 'loyalty_ids'] as const) {
    if (child.data_sharing[flag] && !parent.data_sharing[flag]) violations.push(`data_sharing.${flag}`);
  }
  if (Date.parse(child.exp) > Date.parse(parent.exp)) violations.push('exp');
  return violations;
};

export class MandateWideningError extends Error {
  constructor(public readonly violations: string[]) {
    super(`attenuation would widen the parent mandate: ${violations.join(', ')}`);
    this.name = 'MandateWideningError';
  }
}
