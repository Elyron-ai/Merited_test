import { newId, pence, type Approval, type Mandate, type VerifyResponse } from '@merited/contracts';
import {
  asMint,
  asVerify,
  claimFor,
  createCommitment,
  draftFor,
  iso,
  mintFor,
  verifyClaim,
  type TrioTarget,
} from '../../harness.js';

/**
 * TRIO-15: the demo negative-case fixture kit — the FIVE §10 refusals as
 * data-driven scenarios, each provoking EXACTLY its intended code from
 * public inputs. Act 1 step 8 shows the walletless pair on camera; Act 2
 * step 8 shows MANDATE_REVOKED mid-errand; APPROVAL_MISSING and
 * LIMIT_EXCEEDED run as scripted accept-checks. Consumers (`tools/demo`,
 * PH2-11) use these verbatim — never redefined.
 *
 * Kit rules (the same discipline as the frozen suite): harness + contracts
 * imports only; tokens stay opaque; negatives come from PUBLIC inputs (the
 * QUOTE_EXPIRED fixture is data-driven — a short quote snapshot plus a
 * post-expiry order ts — so nothing ever sleeps).
 */

export type DemoNegativeCode =
  | 'TOKEN_REPLAYED'
  | 'QUOTE_EXPIRED'
  | 'APPROVAL_MISSING'
  | 'LIMIT_EXCEEDED'
  | 'MANDATE_REVOKED';

export interface DemoNegativeFixture {
  reason_code: DemoNegativeCode;
  /** Three are shown on camera (§10); two run as scripted accept-checks. */
  staging: 'on-camera' | 'accept-check';
  /** UK English, printable by the demo harness. */
  narrative: string;
  /** True when the scenario needs the wallet directory fake (in-process
   * targets only until TRIO-17 wires the live directory). */
  needsDirectory: boolean;
  /** Arrange the scenario and return the OFFENDING claim's verdict. */
  provoke(target: TrioTarget): Promise<VerifyResponse>;
}

const seedMandate = async (target: TrioTarget, perTxnPence: number): Promise<Mandate> => {
  const mandate = await target.attest<Mandate>({
    mandate_id: newId('mnd'),
    consumer_ref: newId('usr'),
    agent_id: newId('agt'),
    scopes: ['offers:read', 'checkout:execute'],
    limits: { per_txn: pence(perTxnPence), per_month: pence(150000), categories: ['experiences'] },
    merchants: ['*'],
    data_sharing: { email: false, purchase_history: false, loyalty_ids: true },
    pre_authorised_up_to: pence(5000),
    status: 'active',
    exp: iso(180 * 86400),
  });
  target.directory!.setMandate(mandate);
  return mandate;
};

const seedApproval = async (
  target: TrioTarget,
  mandateId: `mnd_${string}`,
  qid: `qte_${string}`,
): Promise<Approval> => {
  const approval = await target.attest<Approval>({
    approval_id: newId('apr'),
    mandate_id: mandateId,
    quote_id: qid,
    mode: 'explicit',
    approved_at: iso(0),
    exp: iso(300),
  });
  target.directory!.setApproval(approval);
  return approval;
};

export const DEMO_NEGATIVE_FIXTURES: readonly DemoNegativeFixture[] = [
  {
    reason_code: 'TOKEN_REPLAYED',
    staging: 'on-camera',
    narrative: 'The very same token, submitted again — refused.',
    needsDirectory: false,
    async provoke(target) {
      const merchantId = newId('mer');
      const cor = await createCommitment(target, draftFor(merchantId));
      const minted = asMint(await mintFor(target, cor.commitment_id));
      const first = asVerify(
        await verifyClaim(target, await claimFor(target, merchantId, minted.token)),
      );
      if (first.verdict !== 'verified') {
        throw new Error(`replay staging expects a verified first claim, got ${first.verdict}`);
      }
      return asVerify(await verifyClaim(target, await claimFor(target, merchantId, minted.token)));
    },
  },
  {
    reason_code: 'QUOTE_EXPIRED',
    staging: 'on-camera',
    narrative: 'A claim against a quote that had already lapsed — refused.',
    needsDirectory: false,
    async provoke(target) {
      const merchantId = newId('mer');
      const cor = await createCommitment(target, draftFor(merchantId));
      // data-driven expiry: a 2-second quote snapshot and an order timestamp
      // well past it — inside the attribution window, no waiting anywhere
      const minted = asMint(await mintFor(target, cor.commitment_id, { quoteExpS: 2 }));
      return asVerify(
        await verifyClaim(target, await claimFor(target, merchantId, minted.token, { tsOffsetS: 700 })),
      );
    },
  },
  {
    reason_code: 'APPROVAL_MISSING',
    staging: 'accept-check',
    narrative: 'Minted under a mandate but executed without consumer approval — refused.',
    needsDirectory: false, // the SYN-8 guard fires before any directory read
    async provoke(target) {
      const merchantId = newId('mer');
      const cor = await createCommitment(target, draftFor(merchantId));
      const minted = asMint(
        await mintFor(target, cor.commitment_id, { mandateRef: newId('mnd') }),
      );
      return asVerify(await verifyClaim(target, await claimFor(target, merchantId, minted.token)));
    },
  },
  {
    reason_code: 'LIMIT_EXCEEDED',
    staging: 'accept-check',
    narrative: 'An £84.50 order against a mandate capped at £50 per transaction — refused.',
    needsDirectory: true,
    async provoke(target) {
      const merchantId = newId('mer');
      const cor = await createCommitment(target, draftFor(merchantId));
      const mandate = await seedMandate(target, 5000); // £50 cap (D7's £84.50 breaches it)
      const qid = newId('qte');
      const approval = await seedApproval(target, mandate.mandate_id, qid);
      const minted = asMint(
        await mintFor(target, cor.commitment_id, {
          agentId: mandate.agent_id,
          qid,
          apr: approval.approval_id,
          mandateRef: mandate.mandate_id,
        }),
      );
      return asVerify(
        await verifyClaim(target, await claimFor(target, merchantId, minted.token, { grossPence: 8450 })),
      );
    },
  },
  {
    reason_code: 'MANDATE_REVOKED',
    staging: 'on-camera',
    narrative: 'The consumer revoked the mandate mid-errand — the very next claim is refused.',
    needsDirectory: true,
    async provoke(target) {
      const merchantId = newId('mer');
      const cor = await createCommitment(target, draftFor(merchantId));
      const mandate = await seedMandate(target, 15000);
      const qid = newId('qte');
      const approval = await seedApproval(target, mandate.mandate_id, qid);
      const minted = asMint(
        await mintFor(target, cor.commitment_id, {
          agentId: mandate.agent_id,
          qid,
          apr: approval.approval_id,
          mandateRef: mandate.mandate_id,
        }),
      );
      target.directory!.revokeMandate(mandate.mandate_id);
      return asVerify(await verifyClaim(target, await claimFor(target, merchantId, minted.token)));
    },
  },
];
