import { newId, pence } from '@merited/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asCommitment,
  createCommitment,
  createTarget,
  draftFor,
  iso,
  mintFor,
  request,
  type TrioTarget,
} from './harness.js';

/** §7.1 Commitment Signing — TRIO-4 consolidated (TRIO-13 gap sweep). */

let target: TrioTarget;
const merchantId = newId('mer');

beforeAll(async () => {
  target = await createTarget();
});
afterAll(async () => {
  await target.close();
});

describe('commitment signing contract (§7.1)', () => {
  it('unsigned draft in → countersigned COR out, echoing the draft verbatim', async () => {
    const draft = draftFor(merchantId, {}, { budget: pence(60000) });
    const cor = asCommitment(await request(target, 'POST', '/trio/commitments', { body: draft }));
    expect(cor.commitment_id).toMatch(/^com_/);
    expect(cor.merchant_id).toBe(merchantId);
    expect(cor.offer_ref).toBe(draft.offer_ref);
    expect(cor.bounty).toEqual(draft.bounty);
    expect(cor.take_rate_bps).toBe(draft.take_rate_bps);
    expect(cor.agent_commission_bps).toBe(draft.agent_commission_bps);
    expect(cor.terms).toEqual(draft.terms);
    expect(cor.merchant_sig.length).toBeGreaterThan(0);
    expect(cor.platform_sig.length).toBeGreaterThan(0);
    // The COR itself stays budget-free (SYN-12: budget is a Settlement counter).
    expect('budget' in cor).toBe(false);
  });

  it('CORs are immutable: no update surface exists; re-posting mints a new COR', async () => {
    const draft = draftFor(merchantId);
    const first = await createCommitment(target, draft);
    for (const method of ['PUT', 'PATCH'] as const) {
      const attempt = await request(target, method, `/trio/commitments/${first.commitment_id}`, {
        body: draft,
      });
      expect([404, 405]).toContain(attempt.status);
    }
    const second = await createCommitment(target, draft);
    expect(second.commitment_id).not.toBe(first.commitment_id);
  });

  it('malformed drafts are rejected, not coerced', async () => {
    const bad = { ...draftFor(merchantId), take_rate_bps: 'twenty percent' };
    const result = await request(target, 'POST', '/trio/commitments', { body: bad });
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.status).toBeLessThan(500);
  });

  it('/end ends once: 200 → 409 COMMITMENT_ALREADY_ENDED → status ended → mint 409', async () => {
    const cor = await createCommitment(target, draftFor(merchantId));
    const ended = await request(target, 'POST', `/trio/commitments/${cor.commitment_id}/end`, {
      body: { reason: 'contract suite' },
    });
    expect(ended.status).toBe(200);
    expect((ended.body as { ended_at: string }).ended_at).toBeTruthy();

    const again = await request(target, 'POST', `/trio/commitments/${cor.commitment_id}/end`, {
      body: {},
    });
    expect(again.status).toBe(409);

    const status = await request(target, 'GET', `/trio/commitments/${cor.commitment_id}`);
    expect(status.body).toMatchObject({ status: 'ended' });

    const mint = await mintFor(target, cor.commitment_id);
    expect(mint.status).toBe(409);
  });

  it('unknown commitment: /end and status both 404', async () => {
    const ghost = newId('com');
    expect((await request(target, 'POST', `/trio/commitments/${ghost}/end`, { body: {} })).status).toBe(404);
    expect((await request(target, 'GET', `/trio/commitments/${ghost}`)).status).toBe(404);
  });

  it('status reflects liveness: live / not_yet_valid / expired, with counters', async () => {
    const live = await createCommitment(target, draftFor(merchantId, {}, { budget: pence(2400) }));
    const liveStatus = await request(target, 'GET', `/trio/commitments/${live.commitment_id}`);
    expect(liveStatus.body).toMatchObject({
      status: 'live',
      conversions_used: 0,
      max_conversions: 500,
      budget_remaining: { currency: 'GBP_pence', amount: 2400 },
    });

    const early = await createCommitment(
      target,
      draftFor(merchantId, { valid_from: iso(3600), valid_until: iso(7200) }),
    );
    expect((await request(target, 'GET', `/trio/commitments/${early.commitment_id}`)).body).toMatchObject({
      status: 'not_yet_valid',
    });
    expect((await mintFor(target, early.commitment_id)).status).toBe(409);

    const stale = await createCommitment(
      target,
      draftFor(merchantId, { valid_from: iso(-7200), valid_until: iso(-3600) }),
    );
    expect((await request(target, 'GET', `/trio/commitments/${stale.commitment_id}`)).body).toMatchObject({
      status: 'expired',
    });
  });

  it('transport gate: every route except /healthz requires the service token', async () => {
    const noToken = await request(target, 'GET', '/trio/positions/platform', { token: null });
    expect(noToken.status).toBe(401);
    const badToken = await request(target, 'POST', '/trio/commitments', {
      body: draftFor(merchantId),
      token: 'wrong-token',
    });
    expect(badToken.status).toBe(401);
    const health = await request(target, 'GET', '/healthz', { token: null });
    expect(health.status).toBe(200);
    expect(health.body).toMatchObject({ ok: true });
  });
});
