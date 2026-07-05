import { OrderConfirmed, type CommerceAdapter } from '@merited/contracts';
import { describe, expect, it } from 'vitest';

/**
 * The `CommerceAdapter` contract suite (PH3-5 accept: "passes for both
 * FakeShop and Shopify implementations"). Every commerce normalisation must
 * honour the SAME §5.8/§2.4 semantics regardless of platform:
 *   1. the order reference is HASHED at the boundary — raw refs never leave;
 *   2. basket/line-item content is DROPPED — hash + money numbers only;
 *   3. gross value is integer pence (GBP_pence, never floats);
 *   4. a present token crosses byte-identically (opaque);
 *   5. an absent token yields `token: undefined` — the claim path never
 *      starts (P2: no token, no bounty).
 */
export interface CommerceCase {
  adapter: CommerceAdapter;
  /** A platform-native order event carrying the given token (undefined = tokenless). */
  eventWith(token: string | undefined): unknown;
  /** The gross the fixture encodes, in integer pence. */
  expectedGrossPence: number;
  /** A basket string present in the native payload that must NOT survive. */
  basketMarker: string;
}

const TEST_TOKEN = 'v4.public.commerce-contract-token-material';

export const commerceAdapterContractSuite = (name: string, makeCase: () => CommerceCase): void => {
  describe(`CommerceAdapter contract — ${name}`, () => {
    it('hashes the order reference and drops the basket (§2.4 data minimisation)', () => {
      const c = makeCase();
      const order = OrderConfirmed.parse(c.adapter.normaliseOrderEvent(c.eventWith(TEST_TOKEN)));
      expect(order.order_ref_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(order)).not.toContain(c.basketMarker);
    });

    it('gross value crosses as integer pence', () => {
      const c = makeCase();
      const order = OrderConfirmed.parse(c.adapter.normaliseOrderEvent(c.eventWith(TEST_TOKEN)));
      expect(order.gross_value).toEqual({ amount: c.expectedGrossPence, currency: 'GBP_pence' });
      expect(Number.isInteger(order.gross_value.amount)).toBe(true);
    });

    it('a present token crosses byte-identically (opaque)', () => {
      const c = makeCase();
      const order = OrderConfirmed.parse(c.adapter.normaliseOrderEvent(c.eventWith(TEST_TOKEN)));
      expect(order.token).toBe(TEST_TOKEN);
    });

    it('P2: an absent token yields NO token — the claim path never starts', () => {
      const c = makeCase();
      const order = OrderConfirmed.parse(c.adapter.normaliseOrderEvent(c.eventWith(undefined)));
      expect(order.token).toBeUndefined();
    });

    it('the same event normalises deterministically (stable ref hash)', () => {
      const c = makeCase();
      const first = c.adapter.normaliseOrderEvent(c.eventWith(TEST_TOKEN)) as OrderConfirmed;
      const second = c.adapter.normaliseOrderEvent(c.eventWith(TEST_TOKEN)) as OrderConfirmed;
      expect(second.order_ref_hash).toBe(first.order_ref_hash);
    });
  });
};
