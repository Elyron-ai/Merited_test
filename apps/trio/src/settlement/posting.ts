import { EntrySet, pence, type Commitment } from '@merited/contracts';
import { appendEvent } from '@merited/events';
import type pg from 'pg';

/**
 * Double-entry posting engine (TRIO-9, §7.3) — REAL arithmetic, retained
 * into production (spec §7.3: "it's accounting, not crypto"; TRIO-16).
 *
 * Deterministic integer-pence split (SYN/contract-locked by the demo's
 * canonical numbers): platform = floor(bounty × take_bps / 10000),
 * agent = floor(bounty × commission_bps / 10000),
 * reserve = bounty − platform − agent (balances by construction; rounding
 * remainder always lands in reserve).
 */
export const bountyFor = (commitment: Commitment, grossPence: number): number => {
  if (commitment.bounty.type === 'fixed') return commitment.bounty.amount!.amount;
  return Math.floor((grossPence * commitment.bounty.pct_bps!) / 10000);
};

export const splitBounty = (
  bountyPence: number,
  takeRateBps: number,
  commissionBps: number,
): { platform: number; agent: number; reserve: number } => {
  const platform = Math.floor((bountyPence * takeRateBps) / 10000);
  const agent = Math.floor((bountyPence * commissionBps) / 10000);
  return { platform, agent, reserve: bountyPence - platform - agent };
};

/** Pure: the balanced entry set for a verified conversion (Act 1 step 6). */
export const conversionEntrySet = (input: {
  commitment: Commitment;
  agentId: string;
  claimId: `clm_${string}`;
  grossPence: number;
}): EntrySet => {
  const bounty = bountyFor(input.commitment, input.grossPence);
  const split = splitBounty(
    bounty,
    input.commitment.take_rate_bps,
    input.commitment.agent_commission_bps,
  );
  return EntrySet.parse({
    entry_set_id: `set_${input.claimId}`,
    claim_id: input.claimId,
    lines: [
      { account: `merchant_payable:${input.commitment.merchant_id}`, side: 'dr', amount: pence(bounty) },
      { account: `agent_receivable:${input.agentId}`, side: 'cr', amount: pence(split.agent) },
      { account: 'platform_revenue', side: 'cr', amount: pence(split.platform) },
      { account: `reserve:${input.commitment.merchant_id}`, side: 'cr', amount: pence(split.reserve) },
    ],
  });
};

/** Persist a set + emit LedgerEntryPosted, inside the caller's transaction. */
export const storeEntrySet = async (tx: pg.ClientBase, set: EntrySet): Promise<void> => {
  const parsed = EntrySet.parse(set);
  await tx.query('INSERT INTO trio.entry_sets (entry_set_id, claim_id) VALUES ($1, $2)', [
    parsed.entry_set_id,
    parsed.claim_id,
  ]);
  for (const line of parsed.lines) {
    await tx.query(
      'INSERT INTO trio.entry_lines (entry_set_id, account, side, amount_pence) VALUES ($1,$2,$3,$4)',
      [parsed.entry_set_id, line.account, line.side, line.amount.amount],
    );
  }
  await appendEvent(tx, 'LedgerEntryPosted', {
    entry_set_id: parsed.entry_set_id,
    claim_id: parsed.claim_id,
    lines: parsed.lines,
  });
};

/**
 * Exact reversing set for a posted conversion (TRIO-10, arch §2.5): every
 * line side-flipped, amounts and accounts untouched — so the conversion's
 * net effect per account is zero. History is never edited, only appended;
 * the deterministic `set_rev_` id makes the entry_sets PK the arbiter
 * against concurrent double-reversal.
 */
export const reversalEntrySet = (original: EntrySet): EntrySet =>
  EntrySet.parse({
    entry_set_id: `set_rev_${original.claim_id}`,
    claim_id: original.claim_id,
    lines: original.lines.map((line) => ({
      ...line,
      side: line.side === 'dr' ? 'cr' : 'dr',
    })),
  });

/** Re-hydrate a posted set from the ledger rows (the trio's own records). */
export const loadEntrySet = async (
  client: pg.Pool | pg.ClientBase,
  entrySetId: string,
): Promise<EntrySet | null> => {
  const { rows } = await client.query<{
    claim_id: string | null;
    account: string;
    side: 'dr' | 'cr';
    amount_pence: string;
  }>(
    `SELECT es.claim_id, el.account, el.side, el.amount_pence
       FROM trio.entry_sets es JOIN trio.entry_lines el USING (entry_set_id)
      WHERE es.entry_set_id = $1
      ORDER BY el.line_id`,
    [entrySetId],
  );
  if (rows.length === 0) return null;
  return EntrySet.parse({
    entry_set_id: entrySetId,
    claim_id: rows[0]!.claim_id,
    lines: rows.map((r) => ({ account: r.account, side: r.side, amount: pence(Number(r.amount_pence)) })),
  });
};

/**
 * SYN-10: a reversal frees the `max_conversions` counter — and ONLY that
 * counter. Budget spend and mandate month spend stay consumed (the money
 * moved; the promise slot is what reopens).
 */
export const freeConversionCap = async (tx: pg.ClientBase, commitmentId: string): Promise<void> => {
  await tx.query(
    `UPDATE trio.counters
        SET conversions_used = conversions_used - 1, updated_at = now()
      WHERE commitment_id = $1 AND conversions_used > 0`,
    [commitmentId],
  );
};

/**
 * PH1-26 concurrency guard: lock the commitment's counter row and re-check
 * cap and budget INSIDE the verdict transaction. Stage 5's early read is a
 * fast-path only — two concurrent different-jti claims on a cap-1
 * commitment both pass stage 5; this lock serialises them so exactly one
 * applies. Returns the refusal reason instead of applying when the counter
 * cannot cover the conversion; nothing is written on refusal (SYN-9: a
 * rejected claim burns nothing).
 */
export const lockAndCheckCounters = async (
  tx: pg.ClientBase,
  commitmentId: string,
  bountyPence: number,
  maxConversions: number | null,
): Promise<{ ok: true } | { ok: false; reason: 'CAP_EXHAUSTED' | 'BUDGET_EXHAUSTED' }> => {
  const { rows } = await tx.query<{ conversions_used: number; budget_remaining_pence: string | null }>(
    `SELECT conversions_used, budget_remaining_pence
       FROM trio.counters WHERE commitment_id = $1 FOR UPDATE`,
    [commitmentId],
  );
  const row = rows[0];
  if (!row) return { ok: false, reason: 'CAP_EXHAUSTED' }; // no counter row = never mintable
  if (maxConversions !== null && row.conversions_used >= maxConversions) {
    return { ok: false, reason: 'CAP_EXHAUSTED' };
  }
  if (row.budget_remaining_pence !== null && Number(row.budget_remaining_pence) < bountyPence) {
    return { ok: false, reason: 'BUDGET_EXHAUSTED' };
  }
  return { ok: true };
};

/** Counters live in Settlement, outside the immutable COR (arch §2.2). */
export const applyConversionCounters = async (
  tx: pg.ClientBase,
  commitmentId: string,
  bountyPence: number,
): Promise<void> => {
  await tx.query(
    `UPDATE trio.counters
        SET conversions_used = conversions_used + 1,
            budget_remaining_pence = CASE WHEN budget_remaining_pence IS NULL THEN NULL
                                          ELSE budget_remaining_pence - $2 END,
            updated_at = now()
      WHERE commitment_id = $1`,
    [commitmentId, bountyPence],
  );
};

export const monthKey = (date: Date): string => date.toISOString().slice(0, 7); // YYYY-MM

export const recordMandateSpend = async (
  tx: pg.ClientBase,
  mandateRef: string,
  month: string,
  grossPence: number,
): Promise<void> => {
  await tx.query(
    `INSERT INTO trio.mandate_month_spend (mandate_ref, month, spent_pence)
     VALUES ($1, $2, $3)
     ON CONFLICT (mandate_ref, month)
     DO UPDATE SET spent_pence = trio.mandate_month_spend.spent_pence + $3`,
    [mandateRef, month, grossPence],
  );
};

export const mandateMonthSpend = async (
  client: pg.ClientBase,
  mandateRef: string,
  month: string,
): Promise<number> => {
  const { rows } = await client.query<{ spent_pence: string }>(
    'SELECT spent_pence FROM trio.mandate_month_spend WHERE mandate_ref = $1 AND month = $2',
    [mandateRef, month],
  );
  return rows.length ? Number(rows[0]!.spent_pence) : 0;
};
