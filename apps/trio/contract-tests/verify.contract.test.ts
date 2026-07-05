import {
  newId,
  pence,
  REJECTION_REASON_CODES,
  type Approval,
  type Mandate,
  type RejectionReasonCode,
} from '@merited/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asMint,
  asVerify,
  claimFor,
  createCommitment,
  createTarget,
  draftFor,
  iso,
  mintFor,
  request,
  signedPosition,
  verifyClaim,
  type TrioTarget,
} from './harness.js';

/**
 * §7.2 Token Mint + Conversion Verification — TRIO-5/6/8 consolidated.
 * Tokens are opaque strings (claims read ONLY from mint responses, SYN-8);
 * every negative is induced from public inputs. The `seen` set proves the
 * suite covers the complete closed reason-code enum.
 */

let target: TrioTarget;
const merchantId = newId('mer');
const agentId = newId('agt');
const seen = new Set<RejectionReasonCode>();

const expectRejection = (result: unknown, code: RejectionReasonCode): void => {
  expect(result).toEqual({ verdict: 'rejected', reason_code: code });
  seen.add(code);
};

beforeAll(async () => {
  target = await createTarget();
});
afterAll(async () => {
  await target.close();
});

const freshVerified = async () => {
  const cor = await createCommitment(target, draftFor(merchantId));
  const minted = asMint(await mintFor(target, cor.commitment_id, { agentId }));
  const claim = await claimFor(target, merchantId, minted.token);
  const verdict = asVerify(await verifyClaim(target, claim));
  expect(verdict.verdict).toBe('verified');
  return { cor, minted, claim };
};

describe('mint contract (§7.2 mint half)', () => {
  it('mint returns an opaque token plus its claims; claims echo the request', async () => {
    const cor = await createCommitment(target, draftFor(merchantId));
    const qid = newId('qte');
    const minted = asMint(await mintFor(target, cor.commitment_id, { agentId, qid, tier: 'T2' }));
    expect(typeof minted.token).toBe('string');
    expect(minted.token.length).toBeGreaterThan(0);
    expect(minted.claims.cid).toBe(cor.commitment_id);
    expect(minted.claims.qid).toBe(qid);
    expect(minted.claims.aid).toBe(agentId);
    expect(minted.claims.tier).toBe('T2');
    expect(minted.claims.apr).toBeNull();
    expect(minted.claims.exp).toBeGreaterThan(minted.claims.iat);
    expect(minted.claims.exp - minted.claims.iat).toBeLessThanOrEqual(600); // ≤10-min token (§2.3)
  });

  it('mint guards: unknown cid 404; quote snapshot beyond token exp 422', async () => {
    expect((await mintFor(target, newId('com'))).status).toBe(404);
    const cor = await createCommitment(target, draftFor(merchantId));
    expect((await mintFor(target, cor.commitment_id, { quoteExpS: 3600 })).status).toBe(422);
  });

  it('re-mint (B26): same qid + apr set → fresh jti; the re-minted token cannot convert without its approval', async () => {
    const cor = await createCommitment(target, draftFor(merchantId));
    const qid = newId('qte');
    const original = asMint(await mintFor(target, cor.commitment_id, { agentId, qid }));
    const reminted = asMint(
      await mintFor(target, cor.commitment_id, { agentId, qid, apr: newId('apr') }),
    );
    expect(reminted.claims.jti).not.toBe(original.claims.jti);
    expect(reminted.claims.qid).toBe(original.claims.qid);
    expect(reminted.claims.apr).not.toBeNull();

    const verdict = asVerify(
      await verifyClaim(target, await claimFor(target, merchantId, original.token)),
    );
    expect(verdict.verdict).toBe('verified');
    // Stage 6 fires before consumption: an apr-bearing token whose approval
    // is unknown rejects APPROVAL_MISSING (the strict one-per-qid proof needs
    // a valid approval — see the wallet-path suite below).
    expectRejection(
      asVerify(await verifyClaim(target, await claimFor(target, merchantId, reminted.token))),
      'APPROVAL_MISSING',
    );
  });
});

describe('verification contract (§7.2) — the six-stage pipeline from public inputs', () => {
  it('happy walletless path: verified, balanced canonical split, positions move by exactly the preview', async () => {
    const mer = newId('mer'); // fresh parties: position deltas are exact even on a shared target
    const agt = newId('agt');
    const merBefore = await signedPosition(target, mer);
    const agtBefore = await signedPosition(target, agt);

    const cor = await createCommitment(target, draftFor(mer));
    const minted = asMint(await mintFor(target, cor.commitment_id, { agentId: agt }));
    const verdict = asVerify(
      await verifyClaim(target, await claimFor(target, mer, minted.token)),
    );
    expect(verdict.verdict).toBe('verified');
    if (verdict.verdict !== 'verified') return;

    // Demo Act 1 step 6 numbers, normative: 1200 → 720 / 240 / 240.
    expect(verdict.entries_preview.lines).toEqual([
      { account: `merchant_payable:${mer}`, side: 'dr', amount: pence(1200) },
      { account: `agent_receivable:${agt}`, side: 'cr', amount: pence(720) },
      { account: 'platform_revenue', side: 'cr', amount: pence(240) },
      { account: `reserve:${mer}`, side: 'cr', amount: pence(240) },
    ]);

    // Preview == posted, proven over HTTP: live positions moved by exactly
    // the preview lines (reserve:* folds to the shared 'reserve' party per
    // SYN-36, so the merchant party moves by merchant_payable alone).
    expect(await signedPosition(target, mer)).toBe(merBefore - 1200);
    expect(await signedPosition(target, agt)).toBe(agtBefore + 720);
  });

  it('SIG_INVALID: tampered merchant sig; forged token; a claim from the wrong merchant', async () => {
    const cor = await createCommitment(target, draftFor(merchantId));
    const minted = asMint(await mintFor(target, cor.commitment_id, { agentId }));
    const good = await claimFor(target, merchantId, minted.token);
    expectRejection(
      asVerify(
        await verifyClaim(target, { ...good, merchant_sig: good.merchant_sig.slice(0, -2) + 'ff' }),
      ),
      'SIG_INVALID',
    );
    expectRejection(
      asVerify(
        await verifyClaim(
          target,
          await claimFor(target, merchantId, 'v4.public.fake.Zm9yZ2Vk.fake-ed25519:bad'),
        ),
      ),
      'SIG_INVALID',
    );
    // A different merchant signing correctly with their OWN key cannot claim it.
    const thief = newId('mer');
    expectRejection(
      asVerify(await verifyClaim(target, await claimFor(target, thief, minted.token))),
      'SIG_INVALID',
    );
  });

  it('TOKEN_REPLAYED: a verified token never verifies twice', async () => {
    const { minted } = await freshVerified();
    expectRejection(
      asVerify(await verifyClaim(target, await claimFor(target, merchantId, minted.token))),
      'TOKEN_REPLAYED',
    );
  });

  it('WINDOW_EXPIRED, and ordering: window beats quote when both have lapsed', async () => {
    const cor = await createCommitment(target, draftFor(merchantId, { attribution_window_s: 100 }));
    const minted = asMint(await mintFor(target, cor.commitment_id, { agentId, quoteExpS: 60 }));
    expectRejection(
      asVerify(
        await verifyClaim(target, await claimFor(target, merchantId, minted.token, { tsOffsetS: 200 })),
      ),
      'WINDOW_EXPIRED',
    );
  });

  it('QUOTE_EXPIRED: inside the window, past the minted quote snapshot (SYN-8)', async () => {
    const cor = await createCommitment(target, draftFor(merchantId));
    const minted = asMint(await mintFor(target, cor.commitment_id, { agentId, quoteExpS: 60 }));
    expectRejection(
      asVerify(
        await verifyClaim(target, await claimFor(target, merchantId, minted.token, { tsOffsetS: 120 })),
      ),
      'QUOTE_EXPIRED',
    );
  });

  it('COMMITMENT_ENDED both ways (SYN-34): outside COR validity rejects; /end alone does not', async () => {
    const closing = await createCommitment(target, draftFor(merchantId, { valid_until: iso(60) }));
    const minted = asMint(await mintFor(target, closing.commitment_id, { agentId }));
    expectRejection(
      asVerify(
        await verifyClaim(target, await claimFor(target, merchantId, minted.token, { tsOffsetS: 120 })),
      ),
      'COMMITMENT_ENDED',
    );

    // Counterpart: /end stops NEW mints, not in-flight tokens (§5.1 — "no
    // retroactive repricing"): end after mint, the token still verifies.
    const repriced = await createCommitment(target, draftFor(merchantId));
    const inFlight = asMint(await mintFor(target, repriced.commitment_id, { agentId }));
    const ended = await request(target, 'POST', `/trio/commitments/${repriced.commitment_id}/end`, {
      body: { reason: 'bounty repriced' },
    });
    expect(ended.status).toBe(200);
    expect(
      asVerify(await verifyClaim(target, await claimFor(target, merchantId, inFlight.token)))
        .verdict,
    ).toBe('verified');
  });

  it('CAP_EXHAUSTED at max_conversions', async () => {
    const cor = await createCommitment(target, draftFor(merchantId, { max_conversions: 1 }));
    const first = asMint(await mintFor(target, cor.commitment_id, { agentId }));
    expect(
      asVerify(await verifyClaim(target, await claimFor(target, merchantId, first.token))).verdict,
    ).toBe('verified');
    const second = asMint(await mintFor(target, cor.commitment_id, { agentId }));
    expectRejection(
      asVerify(await verifyClaim(target, await claimFor(target, merchantId, second.token))),
      'CAP_EXHAUSTED',
    );
  });

  it('TIER_INELIGIBLE when the token tier is outside the COR', async () => {
    const cor = await createCommitment(
      target,
      draftFor(merchantId, { eligible_identity_tiers: ['T1'] }),
    );
    const minted = asMint(await mintFor(target, cor.commitment_id, { agentId, tier: 'T3' }));
    expectRejection(
      asVerify(await verifyClaim(target, await claimFor(target, merchantId, minted.token))),
      'TIER_INELIGIBLE',
    );
  });

  it('BUDGET_EXHAUSTED when the registered budget cannot cover the bounty', async () => {
    const cor = await createCommitment(target, draftFor(merchantId, {}, { budget: pence(1200) }));
    const first = asMint(await mintFor(target, cor.commitment_id, { agentId }));
    expect(
      asVerify(await verifyClaim(target, await claimFor(target, merchantId, first.token))).verdict,
    ).toBe('verified');
    const second = asMint(await mintFor(target, cor.commitment_id, { agentId }));
    expectRejection(
      asVerify(await verifyClaim(target, await claimFor(target, merchantId, second.token))),
      'BUDGET_EXHAUSTED',
    );
  });

  it('APPROVAL_MISSING via the SYN-8 guard: minted under a mandate, executed without approval', async () => {
    const cor = await createCommitment(target, draftFor(merchantId));
    const minted = asMint(
      await mintFor(target, cor.commitment_id, { agentId, mandateRef: newId('mnd') }),
    );
    expectRejection(
      asVerify(await verifyClaim(target, await claimFor(target, merchantId, minted.token))),
      'APPROVAL_MISSING',
    );
  });

  it('idempotency (§8): same key → byte-identical response, no re-execution; same key + new body → 422', async () => {
    const cor = await createCommitment(target, draftFor(merchantId));
    const minted = asMint(await mintFor(target, cor.commitment_id, { agentId }));
    const claim = await claimFor(target, merchantId, minted.token);
    const key = newId('clm');
    const first = await verifyClaim(target, claim, key);
    const replay = await verifyClaim(target, claim, key);
    expect(first.status).toBe(200);
    expect(replay.text).toBe(first.text); // byte-identical, not TOKEN_REPLAYED

    const conflicting = await claimFor(target, merchantId, minted.token);
    expect((await verifyClaim(target, conflicting, key)).status).toBe(422);
  });
});

describe('wallet path (stage 6) — directory-backed fixtures', () => {
  // Remote targets have no fixture directory (TRIO-17 wires the live one in
  // Phase 1); skip at RUN time — `target` does not exist at collection time.
  const walletIt = (name: string, fn: () => void | Promise<void>): void => {
    it(name, async (ctx) => {
      if (!target.directory) ctx.skip();
      await fn();
    });
  };

  const seedMandate = async (perTxn = 15000, perMonth = 150000): Promise<Mandate> => {
    const mandate = await target.attest<Mandate>({
      mandate_id: newId('mnd'),
      consumer_ref: newId('usr'),
      agent_id: agentId,
      scopes: ['offers:read', 'checkout:execute'],
      limits: { per_txn: pence(perTxn), per_month: pence(perMonth), categories: ['experiences'] },
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
    mandateId: `mnd_${string}`,
    qid: `qte_${string}`,
    expOffsetS = 300,
  ): Promise<Approval> => {
    const approval = await target.attest<Approval>({
      approval_id: newId('apr'),
      mandate_id: mandateId,
      quote_id: qid,
      mode: 'explicit',
      approved_at: iso(0),
      exp: iso(expOffsetS),
    });
    target.directory!.setApproval(approval);
    return approval;
  };

  walletIt(
    'happy wallet path: same claim shape, apr set exercises stage 6 → verified',
    async () => {
      const cor = await createCommitment(target, draftFor(merchantId));
      const mandate = await seedMandate();
      const qid = newId('qte');
      const approval = await seedApproval(mandate.mandate_id, qid);
      const minted = asMint(
        await mintFor(target, cor.commitment_id, {
          agentId,
          qid,
          apr: approval.approval_id,
          mandateRef: mandate.mandate_id,
        }),
      );
      const verdict = asVerify(
        await verifyClaim(target, await claimFor(target, merchantId, minted.token)),
      );
      expect(verdict.verdict).toBe('verified');
    },
  );

  walletIt('one verified conversion per qid (SYN-9): an approved re-mint of a consumed quote is TOKEN_REPLAYED', async () => {
    const cor = await createCommitment(target, draftFor(merchantId));
    const qid = newId('qte');
    const original = asMint(await mintFor(target, cor.commitment_id, { agentId, qid }));
    expect(
      asVerify(await verifyClaim(target, await claimFor(target, merchantId, original.token)))
        .verdict,
    ).toBe('verified');

    // Re-mint against the SAME quote with a fully valid approval: every
    // pipeline stage passes, and consumption still refuses the second
    // conversion — the qid is spent.
    const mandate = await seedMandate();
    const approval = await seedApproval(mandate.mandate_id, qid);
    const reminted = asMint(
      await mintFor(target, cor.commitment_id, {
        agentId,
        qid,
        apr: approval.approval_id,
        mandateRef: mandate.mandate_id,
      }),
    );
    expectRejection(
      asVerify(await verifyClaim(target, await claimFor(target, merchantId, reminted.token))),
      'TOKEN_REPLAYED',
    );
  });

  walletIt('APPROVAL_MISSING when the approval is unknown or quote-mismatched', async () => {
    const cor = await createCommitment(target, draftFor(merchantId));
    const mandate = await seedMandate();
    const minted = asMint(
      await mintFor(target, cor.commitment_id, {
        agentId,
        apr: newId('apr'), // never registered
        mandateRef: mandate.mandate_id,
      }),
    );
    expectRejection(
      asVerify(await verifyClaim(target, await claimFor(target, merchantId, minted.token))),
      'APPROVAL_MISSING',
    );
  });

  walletIt('APPROVAL_EXPIRED past the approval exp', async () => {
    const cor = await createCommitment(target, draftFor(merchantId));
    const mandate = await seedMandate();
    const qid = newId('qte');
    const approval = await seedApproval(mandate.mandate_id, qid, 60);
    const minted = asMint(
      await mintFor(target, cor.commitment_id, {
        agentId,
        qid,
        apr: approval.approval_id,
        mandateRef: mandate.mandate_id,
      }),
    );
    expectRejection(
      asVerify(
        await verifyClaim(target, await claimFor(target, merchantId, minted.token, { tsOffsetS: 120 })),
      ),
      'APPROVAL_EXPIRED',
    );
  });

  walletIt('MANDATE_REVOKED: revocation is seen live on the very next claim', async () => {
    const cor = await createCommitment(target, draftFor(merchantId));
    const mandate = await seedMandate();
    const qid = newId('qte');
    const approval = await seedApproval(mandate.mandate_id, qid);
    const minted = asMint(
      await mintFor(target, cor.commitment_id, {
        agentId,
        qid,
        apr: approval.approval_id,
        mandateRef: mandate.mandate_id,
      }),
    );
    target.directory!.revokeMandate(mandate.mandate_id);
    expectRejection(
      asVerify(await verifyClaim(target, await claimFor(target, merchantId, minted.token))),
      'MANDATE_REVOKED',
    );
  });

  walletIt('LIMIT_EXCEEDED: per-transaction and cumulative per-month', async () => {
    const cor = await createCommitment(target, draftFor(merchantId));
    const mandate = await seedMandate(15000, 20000);

    const qid1 = newId('qte');
    const a1 = await seedApproval(mandate.mandate_id, qid1);
    const overTxn = asMint(
      await mintFor(target, cor.commitment_id, {
        agentId,
        qid: qid1,
        apr: a1.approval_id,
        mandateRef: mandate.mandate_id,
      }),
    );
    expectRejection(
      asVerify(
        await verifyClaim(
          target,
          await claimFor(target, merchantId, overTxn.token, { grossPence: 20000 }),
        ),
      ),
      'LIMIT_EXCEEDED',
    );

    const qid2 = newId('qte');
    const a2 = await seedApproval(mandate.mandate_id, qid2);
    const first = asMint(
      await mintFor(target, cor.commitment_id, {
        agentId,
        qid: qid2,
        apr: a2.approval_id,
        mandateRef: mandate.mandate_id,
      }),
    );
    expect(
      asVerify(
        await verifyClaim(
          target,
          await claimFor(target, merchantId, first.token, { grossPence: 14000 }),
        ),
      ).verdict,
    ).toBe('verified');

    const qid3 = newId('qte');
    const a3 = await seedApproval(mandate.mandate_id, qid3);
    const second = asMint(
      await mintFor(target, cor.commitment_id, {
        agentId,
        qid: qid3,
        apr: a3.approval_id,
        mandateRef: mandate.mandate_id,
      }),
    );
    expectRejection(
      asVerify(
        await verifyClaim(
          target,
          await claimFor(target, merchantId, second.token, { grossPence: 8450 }),
        ),
      ),
      'LIMIT_EXCEEDED',
    );
  });

  walletIt(
    'walletless claims never touch approval checks: a full verify makes ZERO directory reads (PH1-2)',
    async () => {
      const cor = await createCommitment(target, draftFor(merchantId));
      const minted = asMint(await mintFor(target, cor.commitment_id, { agentId }));
      const before = target.directoryReads!();
      const verdict = asVerify(
        await verifyClaim(target, await claimFor(target, merchantId, minted.token)),
      );
      expect(verdict.verdict).toBe('verified');
      expect(target.directoryReads!()).toBe(before); // stage 6 skipped BY DESIGN, not passed vacuously
    },
  );

  walletIt(
    'coverage: the suite has induced every one of the 12 reason codes from public inputs',
    () => {
      // WINDOW_EXPIRED doubles for the clawback window (SYN-10) in the
      // settlement suite; here the full closed enum must have appeared.
      for (const code of REJECTION_REASON_CODES) {
        expect(seen.has(code), `reason code never induced: ${code}`).toBe(true);
      }
    },
  );
});
