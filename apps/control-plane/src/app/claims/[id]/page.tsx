import Link from 'next/link';
import { getPool } from '../../../lib/db';
import { explain } from '../../../lib/reason-copy';

export const dynamic = 'force-dynamic';

const pounds = (pence: number): string =>
  `£${Math.floor(pence / 100)}.${String(pence % 100).padStart(2, '0')}`;

export default async function ClaimDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { rows } = await getPool().query<{
    claim_id: string;
    merchant_id: string;
    order_ref_hash: string;
    gross_pence: number;
    jti: string | null;
    qid: string | null;
    cid: string | null;
    verdict: 'pending' | 'verified' | 'rejected';
    reason_code: string | null;
    created_at: Date;
    updated_at: Date;
  }>(`SELECT * FROM core.claims_intake WHERE claim_id = $1`, [id]);
  const claim = rows[0];
  if (!claim) {
    return (
      <main><p><Link href="/claims">← Claims</Link></p><p>No such claim.</p></main>
    );
  }

  const quote = claim.qid
    ? (
        await getPool().query<{ list_amount: number; final_amount: number; expires_at: Date; tier: string }>(
          `SELECT list_amount, final_amount, expires_at, tier FROM core.quotes WHERE quote_id = $1`,
          [claim.qid],
        )
      ).rows[0] ?? null
    : null;

  return (
    <main>
      <p><Link href="/claims">← Claims</Link></p>
      <h1>{`Claim ${claim.claim_id}`}</h1>
      <p>
        Verdict: <strong>{claim.verdict}</strong>
        {claim.reason_code ? <> · <code>{claim.reason_code}</code></> : null}
      </p>
      {claim.reason_code ? <p><em>{explain(claim.reason_code)}</em></p> : null}
      <p>Gross value: {pounds(claim.gross_pence)} · Order reference (hashed): <code>{`${claim.order_ref_hash.slice(0, 16)}…`}</code></p>

      <h2>Audit path</h2>
      <p>The B24 promise made visible: every hop from the claim back to the committed offer.</p>
      <table cellPadding={6}>
        <tbody>
          <tr><td>Claim</td><td><code>{claim.claim_id}</code></td></tr>
          <tr><td>Attribution token (jti)</td><td><code>{claim.jti ?? '— token did not decode'}</code></td></tr>
          <tr><td>Quote (qid)</td><td><code>{claim.qid ?? '—'}</code></td></tr>
          <tr><td>Commitment (cid)</td><td><code>{claim.cid ?? '—'}</code></td></tr>
        </tbody>
      </table>

      <h2>Quote-time price</h2>
      {quote ? (
        <p>
          {`List ${pounds(quote.list_amount)} → final ${pounds(quote.final_amount)} at tier ${quote.tier}, `}
          {`quoted until ${quote.expires_at.toISOString().replace('T', ' ').slice(0, 19)}.`}
        </p>
      ) : (
        <p>No persisted quote for this claim.</p>
      )}
    </main>
  );
}
