import type pg from 'pg';

/**
 * Replay store (TRIO-6, §7.2 stage 2) — REAL logic, kept through the PH1-25
 * swap ("build this properly, it's not crypto"). Postgres is the source of
 * truth: `consumed_jtis.jti` PK gives single-use tokens; the UNIQUE on `qid`
 * closes the re-mint double-bounty path (SYN-9 — original + re-minted token
 * share a qid; only one may ever verify). Consumption happens in the SAME
 * transaction as the verified verdict (SYN-9: a rejected claim never burns
 * the token). The Redis fast-path cache in front is PH1-25 hardening and is
 * never authoritative (spec §1).
 */
export type ConsumeResult =
  | { consumed: true }
  | { consumed: false; replayed_by: 'jti' | 'qid' };

export const consumeToken = async (
  tx: pg.ClientBase,
  input: { jti: string; qid: string; claim_id: string },
): Promise<ConsumeResult> => {
  const inserted = await tx.query(
    `INSERT INTO trio.consumed_jtis (jti, qid, claim_id)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING jti`,
    [input.jti, input.qid, input.claim_id],
  );
  if (inserted.rows.length === 1) return { consumed: true };

  const byJti = await tx.query('SELECT 1 FROM trio.consumed_jtis WHERE jti = $1', [input.jti]);
  return { consumed: false, replayed_by: byJti.rows.length > 0 ? 'jti' : 'qid' };
};

/** Read-only replay probe (used by verification's pipeline ordering tests). */
export const isConsumed = async (client: pg.ClientBase, jti: string): Promise<boolean> => {
  const { rows } = await client.query('SELECT 1 FROM trio.consumed_jtis WHERE jti = $1', [jti]);
  return rows.length > 0;
};
