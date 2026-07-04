import type { BountyInput } from '@merited/core';

const int = (raw: string, name: string): number => {
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be a whole number`);
  return Number.parseInt(raw.trim(), 10);
};

/** Bounty fields from the publish/reprice forms — integers only, and the
 * union shape enforced (fixed → amount pence; pct_of_order → bps). */
export const bountyFrom = (form: FormData): BountyInput['bounty'] | null => {
  const type = String(form.get('bounty_type') ?? '').trim();
  if (!type) return null;
  if (type === 'fixed') {
    return {
      type: 'fixed',
      amount: { amount: int(String(form.get('bounty_amount') ?? ''), 'bounty amount'), currency: 'GBP_pence' },
    };
  }
  if (type === 'pct_of_order') {
    return { type: 'pct_of_order', pct_bps: int(String(form.get('bounty_pct_bps') ?? ''), 'bounty rate') };
  }
  throw new Error(`unknown bounty type '${type}'`);
};
