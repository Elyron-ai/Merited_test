import Link from 'next/link';
import { getPool } from '../../../../lib/db';
import { getMerchantsService } from '../../../../lib/platform';
import { explain } from '../../../../lib/reason-copy';

export const dynamic = 'force-dynamic';

/**
 * Merchant dashboard (PH2-2, B19/§5.9): every number on this page comes from
 * a ledger-driven projection table — no new data collection (arch §3.5), so
 * a wipe + `pnpm analytics:rebuild` reproduces the page exactly. Rejection
 * AND read-path suppression reasons are first-class (§3: "both sides must
 * see why"); `BUDGET_EXHAUSTED` from the PH2-1 guardrails lands here, which
 * closes §5.6's Accept loop.
 */

/** Signed pounds from integer pence (reversals credit budget burn back). */
const pounds = (pence: number): string => {
  const sign = pence < 0 ? '−' : '';
  const abs = Math.abs(pence);
  return `${sign}£${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

const day = (value: Date): string => value.toISOString().slice(0, 10);

export default async function MerchantDashboard({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const merchant = await getMerchantsService().get(id);
  const pool = getPool();

  const { rows: mintVsClaim } = await pool.query<{
    day: Date;
    mints: string;
    claims: string;
    verified: string;
    rejected: string;
  }>(
    `SELECT day, mints, claims, verified, rejected
       FROM core.mint_vs_claim_by_merchant_day
      WHERE merchant_id = $1 ORDER BY day DESC LIMIT 14`,
    [id],
  );

  const { rows: reasons } = await pool.query<{
    reason_code: string;
    count: string;
    days: string;
    agents: string;
  }>(
    `SELECT reason_code, SUM(count) AS count,
            COUNT(DISTINCT day) AS days, COUNT(DISTINCT agent_id) AS agents
       FROM core.rejections_by_reason_day
      WHERE merchant_id = $1
      GROUP BY reason_code ORDER BY SUM(count) DESC, reason_code`,
    [id],
  );

  const { rows: reasonsByAgent } = await pool.query<{
    agent_id: string;
    reason_code: string;
    count: string;
  }>(
    `SELECT agent_id, reason_code, SUM(count) AS count
       FROM core.rejections_by_reason_day
      WHERE merchant_id = $1
      GROUP BY agent_id, reason_code ORDER BY SUM(count) DESC, agent_id, reason_code
      LIMIT 20`,
    [id],
  );

  const { rows: burn } = await pool.query<{
    commitment_id: string;
    day: Date;
    bounty_burned_pence: string;
  }>(
    `SELECT commitment_id, day, bounty_burned_pence
       FROM core.budget_burn
      WHERE merchant_id = $1 ORDER BY day DESC, commitment_id LIMIT 30`,
    [id],
  );
  const burnTotal = burn.reduce((sum, row) => sum + Number(row.bounty_burned_pence), 0);

  return (
    <main>
      <p><Link href={`/merchants/${id}`}>← {merchant.name}</Link></p>
      <h1>Merchant dashboard</h1>
      <p style={{ maxWidth: '42rem' }}>
        Every figure below is read from ledger-driven analytics projections (B19) — nothing on
        this page is collected separately, so a projection rebuild reproduces it exactly.
      </p>

      <h2>Mint vs claim (last 14 days)</h2>
      <p>
        Tokens minted without claims arriving is the under-reporting signature — the{' '}
        <a href={`/merchants/${id}/health`}>health page</a> holds the monitor&rsquo;s verdict.
      </p>
      <table cellPadding={6}>
        <thead>
          <tr><th align="left">Day</th><th align="right">Mints</th><th align="right">Claims</th><th align="right">Verified</th><th align="right">Rejected</th></tr>
        </thead>
        <tbody>
          {mintVsClaim.map((row) => (
            <tr key={day(row.day)}>
              <td>{day(row.day)}</td>
              <td align="right">{row.mints}</td>
              <td align="right">{row.claims}</td>
              <td align="right">{row.verified}</td>
              <td align="right">{row.rejected}</td>
            </tr>
          ))}
          {mintVsClaim.length === 0 && <tr><td colSpan={5}>No mint or claim activity yet.</td></tr>}
        </tbody>
      </table>

      <h2>Why conversions were rejected or offers suppressed</h2>
      <p style={{ maxWidth: '42rem' }}>
        Verify-path rejections and read-path guardrail suppressions, one row per reason code.
      </p>
      <table cellPadding={6}>
        <thead>
          <tr><th align="left">Reason</th><th align="right">Count</th><th align="right">Days seen</th><th align="right">Agents</th><th align="left">What it means</th></tr>
        </thead>
        <tbody>
          {reasons.map((row) => (
            <tr key={row.reason_code} data-reason={row.reason_code}>
              <td><code>{row.reason_code}</code></td>
              <td align="right">{row.count}</td>
              <td align="right">{row.days}</td>
              <td align="right">{row.agents}</td>
              <td>{explain(row.reason_code)}</td>
            </tr>
          ))}
          {reasons.length === 0 && <tr><td colSpan={5}>Nothing rejected or suppressed — clean sheet.</td></tr>}
        </tbody>
      </table>

      {reasonsByAgent.length > 0 && (
        <>
          <h3>By agent</h3>
          <table cellPadding={6}>
            <thead>
              <tr><th align="left">Agent</th><th align="left">Reason</th><th align="right">Count</th></tr>
            </thead>
            <tbody>
              {reasonsByAgent.map((row) => (
                <tr key={`${row.agent_id}:${row.reason_code}`}>
                  <td><code>{row.agent_id}</code></td>
                  <td><code>{row.reason_code}</code></td>
                  <td align="right">{row.count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>Budget burn</h2>
      <p>
        Bounty burned per commitment per day; reversals credit back on their own day. Total
        shown: <strong>{pounds(burnTotal)}</strong>. Remaining budget is live commitment state
        on the trio, not a projection.
      </p>
      <table cellPadding={6}>
        <thead>
          <tr><th align="left">Day</th><th align="left">Commitment</th><th align="right">Burned</th></tr>
        </thead>
        <tbody>
          {burn.map((row) => (
            <tr key={`${row.commitment_id}:${day(row.day)}`}>
              <td>{day(row.day)}</td>
              <td><code>{row.commitment_id}</code></td>
              <td align="right">{pounds(Number(row.bounty_burned_pence))}</td>
            </tr>
          ))}
          {burn.length === 0 && <tr><td colSpan={3}>No bounty burned yet.</td></tr>}
        </tbody>
      </table>
    </main>
  );
}
