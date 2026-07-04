import { describe, expect, it } from 'vitest';
import { Money, pence } from './money.js';

describe('Money (FND-3 accept — §0.4 integer pence, never floats)', () => {
  it('accepts non-negative integer pence', () => {
    expect(Money.parse({ amount: 0, currency: 'GBP_pence' }).amount).toBe(0);
    expect(Money.parse({ amount: 1200, currency: 'GBP_pence' }).amount).toBe(1200);
    expect(pence(8450)).toEqual({ amount: 8450, currency: 'GBP_pence' });
  });

  it('rejects floats', () => {
    expect(Money.safeParse({ amount: 12.5, currency: 'GBP_pence' }).success).toBe(false);
    expect(Money.safeParse({ amount: 0.01, currency: 'GBP_pence' }).success).toBe(false);
  });

  it('rejects negatives', () => {
    expect(Money.safeParse({ amount: -1, currency: 'GBP_pence' }).success).toBe(false);
  });

  it('rejects other currencies', () => {
    expect(Money.safeParse({ amount: 100, currency: 'GBP' }).success).toBe(false);
    expect(Money.safeParse({ amount: 100, currency: 'USD_cents' }).success).toBe(false);
    expect(Money.safeParse({ amount: 100 }).success).toBe(false);
  });
});
