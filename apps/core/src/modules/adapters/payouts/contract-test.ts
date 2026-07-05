import type { PayoutRail } from '@merited/contracts';
import { describe, expect, it } from 'vitest';

/**
 * The SHARED PayoutRail adapter contract suite (PH1-29 → PH2-6). Phase 1 runs
 * it against `SimulatedPayouts`; PH2-6 imports THIS SAME function and runs it
 * against `StripeConnectPayouts` (test mode) — one behaviour, two rails. Keep
 * every assertion implementation-agnostic: only the `PayoutRail` port and its
 * money/idempotency semantics.
 */
export const payoutRailContractSuite = (
  name: string,
  makeRail: () => Promise<PayoutRail> | PayoutRail,
): void => {
  describe(`PayoutRail contract — ${name}`, () => {
    const pence = (amount: number) => ({ amount, currency: 'GBP_pence' as const });

    it('createAccount is stable per party: same party → same account_ref, always', async () => {
      const rail = await makeRail();
      const first = await rail.createAccount('agt_contract_party');
      const again = await rail.createAccount('agt_contract_party');
      expect(again.account_ref).toBe(first.account_ref);
      const other = await rail.createAccount('mer_contract_party');
      expect(other.account_ref).not.toBe(first.account_ref);
    });

    it('transfer is idempotent per key: a replay returns the SAME transfer_ref (no double payout)', async () => {
      const rail = await makeRail();
      const { account_ref } = await rail.createAccount('agt_idem_party');
      const first = await rail.transfer({ account_ref, amount: pence(720), idempotency_key: 'run-1/agt_idem_party' });
      const replay = await rail.transfer({ account_ref, amount: pence(720), idempotency_key: 'run-1/agt_idem_party' });
      expect(replay.transfer_ref).toBe(first.transfer_ref);

      // a DIFFERENT key is a different transfer
      const second = await rail.transfer({ account_ref, amount: pence(720), idempotency_key: 'run-2/agt_idem_party' });
      expect(second.transfer_ref).not.toBe(first.transfer_ref);
    });

    it('amounts are integer pence, never floats: a fractional amount is refused', async () => {
      const rail = await makeRail();
      const { account_ref } = await rail.createAccount('agt_money_party');
      await expect(
        rail.transfer({
          account_ref,
          // eslint-disable-next-line merited/no-float-currency -- the NEGATIVE probe: this float MUST be refused
          amount: { amount: 7.2, currency: 'GBP_pence' },
          idempotency_key: 'bad-money',
        }),
      ).rejects.toThrow();
    });

    it('reverse(transfer_ref) succeeds and is idempotent (a second reverse is a no-op)', async () => {
      const rail = await makeRail();
      const { account_ref } = await rail.createAccount('agt_reverse_party');
      const { transfer_ref } = await rail.transfer({ account_ref, amount: pence(500), idempotency_key: 'rev-1' });
      await expect(rail.reverse(transfer_ref)).resolves.toBeUndefined();
      await expect(rail.reverse(transfer_ref)).resolves.toBeUndefined();
    });
  });
};
