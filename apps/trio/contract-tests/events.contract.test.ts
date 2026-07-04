import { newId } from '@merited/contracts';
import { verifyChain } from '@merited/events';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  asMint,
  asReverse,
  asVerify,
  claimFor,
  createCommitment,
  createTarget,
  draftFor,
  mintFor,
  request,
  reverseFor,
  verifyClaim,
  type TrioTarget,
} from './harness.js';

/**
 * Event-emission assertions (TRIO-13 gap sweep). These inspect the ledger
 * database directly, so they run only when the harness booted the target
 * itself — a remote deployment's ledger is not the suite's to open. The
 * HTTP-observable contract is covered by the other files either way.
 */

let target: TrioTarget;

beforeAll(async () => {
  target = await createTarget();
});
afterAll(async () => {
  await target.close();
});

const ledgerIt = (name: string, fn: () => Promise<void>): void => {
  it(name, async (ctx) => {
    if (!target.db) ctx.skip();
    await fn();
  });
};

describe('every trio action lands in the hash-chained ledger', () => {
  ledgerIt('the full moat spine emits its events and the chain verifies end-to-end', async () => {
    const mer = newId('mer');
    const agt = newId('agt');
    const cor = await createCommitment(target, draftFor(mer));
    const minted = asMint(await mintFor(target, cor.commitment_id, { agentId: agt }));
    const claim = await claimFor(target, mer, minted.token);
    expect(asVerify(await verifyClaim(target, claim)).verdict).toBe('verified');
    // One induced rejection (replay) so ConversionRejected is present too.
    expect(asVerify(await verifyClaim(target, await claimFor(target, mer, minted.token)))).toEqual({
      verdict: 'rejected',
      reason_code: 'TOKEN_REPLAYED',
    });
    expect(asReverse(await reverseFor(target, mer, claim.claim_id)).verdict).toBe('reversed');
    const run = await request(target, 'POST', '/trio/netting/run', {
      body: { period: new Date().toISOString().slice(0, 7) },
    });
    expect(run.status).toBe(200);
    await request(target, 'POST', `/trio/commitments/${cor.commitment_id}/end`, {
      body: { reason: 'suite complete' },
    });

    const db = target.db!;
    const counts = new Map<string, number>();
    const { rows } = await db.query<{ type: string; n: string }>(
      `SELECT type, count(*) AS n FROM events.events GROUP BY type`,
    );
    for (const row of rows) counts.set(row.type, Number(row.n));
    for (const expected of [
      'CommitmentCreated',
      'CommitmentEnded',
      'TokenMinted',
      'ConversionVerified',
      'ConversionRejected',
      'ConversionReversed',
      'LedgerEntryPosted',
      'SettlementNetted',
    ]) {
      expect(counts.get(expected) ?? 0, `missing event: ${expected}`).toBeGreaterThan(0);
    }
    // Entry posting is mirrored per set: conversion + reversal = 2 postings.
    expect(counts.get('LedgerEntryPosted')).toBeGreaterThanOrEqual(2);

    const client = await db.connect();
    try {
      const verification = await verifyChain(client);
      expect(verification).toMatchObject({ ok: true });
      if (verification.ok) expect(verification.count).toBeGreaterThanOrEqual(8);
    } finally {
      client.release();
    }
  });
});
