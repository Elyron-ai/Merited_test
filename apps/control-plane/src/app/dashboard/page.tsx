import Link from 'next/link';
import { getPool } from '../../lib/db';
import { explain } from '../../lib/reason-copy';

export const dynamic = 'force-dynamic';

/**
 * Platform dashboard (PH2-2, B19/§5.9): the four analytics projections in
 * one operator view — conversions per agent, mint-vs-claim, rejection and
 * suppression reasons, budget burn. Read-only over projection tables; a
 * wipe + rebuild reproduces this page exactly (arch §3.5: no new data
 * collection).
 */

const pounds = (pence: number): string => {
  const sign = pence < 0 ? '−' : '';
  const abs = Math.abs(pence);
  return `${sign}£${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
};

const day = (value: Date): string => value.toISOString().slice(0, 10);

export default async function PlatformDashboard() {
  const pool = getPool();

  const { rows: conversions } = await pool.query<{
    agent_id: string;
    day: Date;
    conversions: string;
    gross_pence: string;
  }>(
    `SELECT agent_id, day, conversions, gross_pence
       FROM core.conversions_by_agent_day
      ORDER BY day DESC, gross_pence DESC, agent_id LIMIT 30`,
  );

  const { rows: mintVsClaim } = await pool.query<{
    day: Date;
    mints: string;
    claims: string;
    verified: string;
    rejected: string;
  }>(
    `SELECT day, SUM(mints) AS mints, SUM(claims) AS claims,
            SUM(verified) AS verified, SUM(rejected) AS rejected
       FROM core.mint_vs_claim_by_merchant_day
      GROUP BY day ORDER BY day DESC LIMIT 14`,
  );

  const { rows: reasons } = await pool.query<{
    reason_code: string;
    merchants: string;
    count: string;
  }>(
    `SELECT reason_code, COUNT(DISTINCT merchant_id) AS merchants, SUM(count) AS count
       FROM core.rejections_by_reason_day
      GROUP BY reason_code ORDER BY SUM(count) DESC, reason_code`,
  );

  const { rows: burn } = await pool.query<{
    merchant_id: string;
    day: Date;
    burned: string;
  }>(
    `SELECT merchant_id, day, SUM(bounty_burned_pence) AS burned
       FROM core.budget_burn
      GROUP BY merchant_id, day ORDER BY day DESC, merchant_id LIMIT 30`,
  );

  return (
    <main>
      <p><Link href="/">← Home</Link></p>
      <h1>Platform dashboard</h1>
      <p style={{ maxWidth: '42rem' }}>
        The B19 projections in one view. Every table is rebuilt from the event ledger alone —
        disposable read models over an append-only source of truth.
      </p>

      <h2>Conversions by agent</h2>
      <table cellPadding={6}>
        <thead>
          <tr><th align="left">Day</th><th align="left">Agent</th><th align="right">Conversions</th><th align="right">Gross</th></tr>
        </thead>
        <tbody>
          {conversions.map((row) => (
            <tr key={`${row.agent_id}:${day(row.day)}`}>
              <td>{day(row.day)}</td>
              <td><code>{row.agent_id}</code></td>
              <td align="right">{row.conversions}</td>
              <td align="right">{pounds(Number(row.gross_pence))}</td>
            </tr>
          ))}
          {conversions.length === 0 && <tr><td colSpan={4}>No verified conversions yet.</td></tr>}
        </tbody>
      </table>

      <h2>Mint vs claim, platform-wide</h2>
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

      <h2>Rejections and suppressions by reason</h2>
      <table cellPadding={6}>
        <thead>
          <tr><th align="left">Reason</th><th align="right">Merchants</th><th align="right">Count</th><th align="left">What it means</th></tr>
        </thead>
        <tbody>
          {reasons.map((row) => (
            <tr key={row.reason_code} data-reason={row.reason_code}>
              <td><code>{row.reason_code}</code></td>
              <td align="right">{row.merchants}</td>
              <td align="right">{row.count}</td>
              <td>{explain(row.reason_code)}</td>
            </tr>
          ))}
          {reasons.length === 0 && <tr><td colSpan={4}>Nothing rejected or suppressed — clean sheet.</td></tr>}
        </tbody>
      </table>

      <h2>Budget burn by merchant</h2>
      <table cellPadding={6}>
        <thead>
          <tr><th align="left">Day</th><th align="left">Merchant</th><th align="right">Burned</th></tr>
        </thead>
        <tbody>
          {burn.map((row) => (
            <tr key={`${row.merchant_id}:${day(row.day)}`}>
              <td>{day(row.day)}</td>
              <td><code>{row.merchant_id}</code></td>
              <td align="right">{pounds(Number(row.burned))}</td>
            </tr>
          ))}
          {burn.length === 0 && <tr><td colSpan={3}>No bounty burned yet.</td></tr>}
        </tbody>
      </table>
    </main>
  );
}
