import { newId, Statement } from '@merited/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asMint,
  asReverse,
  asVerify,
  claimFor,
  createCommitment,
  createTarget,
  draftFor,
  fetchPdf,
  mintFor,
  request,
  reverseFor,
  signedPosition,
  verifyClaim,
  type TrioTarget,
} from './harness.js';

/**
 * §7.3 Net Settlement — TRIO-9/10/11 consolidated (TRIO-12's property suite
 * covers depth; this file locks the deterministic wire behaviour). All
 * assertions are HTTP-only and use fresh party ids, so they hold verbatim
 * against a shared remote target.
 */

let target: TrioTarget;
const period = new Date().toISOString().slice(0, 7); // YYYY-MM, current period

beforeAll(async () => {
  target = await createTarget();
});
afterAll(async () => {
  await target.close();
});

const verifiedConversion = async (
  overrides: Parameters<typeof draftFor>[1] = {},
): Promise<{ mer: `mer_${string}`; agt: `agt_${string}`; cid: string; claimId: `clm_${string}` }> => {
  const mer = newId('mer');
  const agt = newId('agt');
  const cor = await createCommitment(target, draftFor(mer, overrides));
  const minted = asMint(await mintFor(target, cor.commitment_id, { agentId: agt }));
  const claim = await claimFor(target, mer, minted.token);
  expect(asVerify(await verifyClaim(target, claim)).verdict).toBe('verified');
  return { mer, agt, cid: cor.commitment_id, claimId: claim.claim_id };
};

describe('clawback reversal contract (§7.3, SYN-10/35)', () => {
  it('reverse within window: exact side-flipped set, positions return to zero', async () => {
    const { mer, agt, cid, claimId } = await verifiedConversion();
    expect(await signedPosition(target, mer)).toBe(-1200);
    expect(await signedPosition(target, agt)).toBe(720);

    const reversed = asReverse(await reverseFor(target, mer, claimId, 'refunded'));
    expect(reversed.verdict).toBe('reversed');
    if (reversed.verdict !== 'reversed') return;
    expect(reversed.entries_preview.lines).toEqual([
      { account: `merchant_payable:${mer}`, side: 'cr', amount: { currency: 'GBP_pence', amount: 1200 } },
      { account: `agent_receivable:${agt}`, side: 'dr', amount: { currency: 'GBP_pence', amount: 720 } },
      { account: 'platform_revenue', side: 'dr', amount: { currency: 'GBP_pence', amount: 240 } },
      { account: `reserve:${mer}`, side: 'dr', amount: { currency: 'GBP_pence', amount: 240 } },
    ]);

    // Net effect zero for the conversion, observed over HTTP.
    expect(await signedPosition(target, mer)).toBe(0);
    expect(await signedPosition(target, agt)).toBe(0);

    // SYN-10: the cap is freed.
    const status = await request(target, 'GET', `/trio/commitments/${cid}`);
    expect(status.body).toMatchObject({ conversions_used: 0 });
  });

  it('reverse after the clawback window: WINDOW_EXPIRED, nothing posted (public inputs only)', async () => {
    const { mer, agt, claimId } = await verifiedConversion({ clawback_window_s: 0 });
    await new Promise((resolve) => setTimeout(resolve, 100)); // strictly past a zero window
    expect(asReverse(await reverseFor(target, mer, claimId))).toEqual({
      verdict: 'rejected',
      reason_code: 'WINDOW_EXPIRED',
    });
    expect(await signedPosition(target, mer)).toBe(-1200);
    expect(await signedPosition(target, agt)).toBe(720);
  });

  it('double-reverse rejected (TOKEN_REPLAYED), cap freed exactly once', async () => {
    const { mer, cid, claimId } = await verifiedConversion();
    expect(asReverse(await reverseFor(target, mer, claimId)).verdict).toBe('reversed');
    expect(asReverse(await reverseFor(target, mer, claimId))).toEqual({
      verdict: 'rejected',
      reason_code: 'TOKEN_REPLAYED',
    });
    expect((await request(target, 'GET', `/trio/commitments/${cid}`)).body).toMatchObject({
      conversions_used: 0,
    });
    expect(await signedPosition(target, mer)).toBe(0); // reversed once, not twice
  });

  it('unknown claim, bad signature, and a foreign merchant all reject as SIG_INVALID (SYN-35)', async () => {
    const { mer, claimId } = await verifiedConversion();
    expect(asReverse(await reverseFor(target, mer, newId('clm')))).toEqual({
      verdict: 'rejected',
      reason_code: 'SIG_INVALID',
    });
    expect(asReverse(await reverseFor(target, newId('mer'), claimId))).toEqual({
      verdict: 'rejected',
      reason_code: 'SIG_INVALID',
    });
    const good = await reverseFor(target, mer, claimId); // consumes the reversal…
    expect(asReverse(good).verdict).toBe('reversed');
  });

  it('reversal reopens a CAP_EXHAUSTED commitment end-to-end (SYN-10)', async () => {
    const { mer, cid, claimId } = await verifiedConversion({ max_conversions: 1 });
    const blocked = asMint(await mintFor(target, cid));
    expect(asVerify(await verifyClaim(target, await claimFor(target, mer, blocked.token)))).toEqual(
      { verdict: 'rejected', reason_code: 'CAP_EXHAUSTED' },
    );
    expect(asReverse(await reverseFor(target, mer, claimId)).verdict).toBe('reversed');
    const reopened = asMint(await mintFor(target, cid));
    expect(
      asVerify(await verifyClaim(target, await claimFor(target, mer, reopened.token))).verdict,
    ).toBe('verified');
  });
});

describe('netting + positions + statements contract (§7.3)', () => {
  it('netting folds un-netted entries to balanced per-party positions; a set folds exactly once', async () => {
    const { mer, agt } = await verifiedConversion();

    const run = await request(target, 'POST', '/trio/netting/run', { body: { period } });
    expect(run.status).toBe(200);
    const positions = (run.body as { positions: Array<{ party: string; direction: string; amount: { amount: number } }> })
      .positions;

    // Trial balance over the wire: the folded positions sum to zero.
    const signedSum = positions.reduce(
      (sum, p) => sum + (p.direction === 'receivable' ? p.amount.amount : -p.amount.amount),
      0,
    );
    expect(signedSum).toBe(0);
    expect(positions).toContainEqual({
      party: mer,
      direction: 'payable',
      amount: { currency: 'GBP_pence', amount: 1200 },
    });
    expect(positions).toContainEqual({
      party: agt,
      direction: 'receivable',
      amount: { currency: 'GBP_pence', amount: 720 },
    });

    // Already-netted sets never fold again: this suite's parties are absent
    // from the immediately-following run.
    const rerun = await request(target, 'POST', '/trio/netting/run', { body: { period } });
    const rerunParties = (rerun.body as { positions: Array<{ party: string }> }).positions.map(
      (p) => p.party,
    );
    expect(rerunParties).not.toContain(mer);
    expect(rerunParties).not.toContain(agt);
  });

  it('reversal of an already-netted conversion folds into the NEXT (open) period run', async () => {
    const { mer, agt, claimId } = await verifiedConversion();
    await request(target, 'POST', '/trio/netting/run', { body: { period } });
    expect(asReverse(await reverseFor(target, mer, claimId)).verdict).toBe('reversed');

    const next = await request(target, 'POST', '/trio/netting/run', { body: { period } });
    const positions = (next.body as { positions: Array<Record<string, unknown>> }).positions;
    expect(positions).toContainEqual({
      party: mer,
      direction: 'receivable',
      amount: { currency: 'GBP_pence', amount: 1200 },
    });
    expect(positions).toContainEqual({
      party: agt,
      direction: 'payable',
      amount: { currency: 'GBP_pence', amount: 720 },
    });
  });

  it('statement parses against the contract schema and its closing equals the live position', async () => {
    const { mer } = await verifiedConversion();
    const result = await request(target, 'GET', `/trio/statements/${mer}/${period}`);
    expect(result.status).toBe(200);
    const statement = Statement.parse(result.body);
    expect(statement.party).toBe(mer);
    expect(statement.period).toBe(period);
    expect(statement.opening).toEqual({ direction: 'receivable', amount: { currency: 'GBP_pence', amount: 0 } });
    expect(statement.lines).toHaveLength(1);
    expect(statement.lines[0]).toMatchObject({ seq: 1, side: 'dr', amount: { amount: 1200 } });

    const closingSigned =
      statement.closing.direction === 'receivable'
        ? statement.closing.amount.amount
        : -statement.closing.amount.amount;
    expect(closingSigned).toBe(await signedPosition(target, mer));
  });

  it('statement PDF: application/pdf, non-empty, names the party', async () => {
    const { mer } = await verifiedConversion();
    const pdf = await fetchPdf(target, `/trio/statements/${mer}/${period}/pdf`);
    expect(pdf.status).toBe(200);
    expect(pdf.contentType).toContain('application/pdf');
    expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(pdf.bytes.length).toBeGreaterThan(1000);
    expect(pdf.bytes.toString('latin1')).toContain(mer);
  }, 60000);

  it('malformed period rejected on statements and netting runs', async () => {
    expect((await request(target, 'GET', '/trio/statements/platform/13-2026')).status).toBe(400);
    expect(
      (await request(target, 'POST', '/trio/netting/run', { body: { period: '2026-13' } })).status,
    ).toBe(400);
  });
});
