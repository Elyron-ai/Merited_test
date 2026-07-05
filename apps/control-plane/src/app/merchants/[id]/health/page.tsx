import Link from 'next/link';
import { getPool } from '../../../../lib/db';
import { getMerchantsService } from '../../../../lib/platform';

export const dynamic = 'force-dynamic';

/**
 * Merchant health (PH1-20): the mint-vs-claim badge — architecture §5's
 * under-reporting failure mode made visible on the merchant record. The
 * verdict is written by the continuously-running monitor; this page is a
 * read-only view of `core.merchant_health` plus the recent day-by-day feed.
 */
const BADGE: Record<string, { label: string; background: string }> = {
  healthy: { label: '✅ Healthy', background: '#0a3d1f' },
  under_reporting: { label: '⚠️ UNDER-REPORTING', background: '#5a1a1a' },
  insufficient_data: { label: 'ℹ️ Insufficient data', background: '#333' },
};

export default async function MerchantHealth({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const merchant = await getMerchantsService().get(id);
  const { rows: health } = await getPool().query<{
    status: string;
    claim_rate_bps: number | null;
    mints: string;
    claims: string;
    window_days: number;
    floor_bps: number;
    evaluated_at: Date;
  }>(`SELECT status, claim_rate_bps, mints, claims, window_days, floor_bps, evaluated_at
        FROM core.merchant_health WHERE merchant_id = $1`, [id]);
  const { rows: days } = await getPool().query<{
    day: Date;
    mints: string;
    claims: string;
    verified: string;
    rejected: string;
  }>(`SELECT day, mints, claims, verified, rejected
        FROM core.mint_vs_claim_by_merchant_day
       WHERE merchant_id = $1 ORDER BY day DESC LIMIT 14`, [id]);

  const verdict = health[0];
  const badge = verdict ? BADGE[verdict.status]! : null;

  return (
    <main>
      <p><Link href={`/merchants/${id}`}>← {merchant.name}</Link></p>
      <h1>Mint-vs-claim health</h1>

      {verdict && badge ? (
        <>
          <p>
            <strong
              style={{ background: badge.background, padding: '0.3rem 0.7rem', borderRadius: '0.4rem' }}
              data-status={verdict.status}
            >
              {badge.label}
            </strong>
          </p>
          <p>
            Claim rate:{' '}
            <code>{verdict.claim_rate_bps === null ? 'n/a' : `${(verdict.claim_rate_bps / 100).toFixed(2)}%`}</code>{' '}
            over the trailing {verdict.window_days} days ({verdict.claims} claims / {verdict.mints} mints; floor{' '}
            {(verdict.floor_bps / 100).toFixed(2)}%). Evaluated {verdict.evaluated_at.toISOString()}.
          </p>
          <p style={{ maxWidth: '42rem' }}>
            Tokens minted without claims arriving is the signature of a merchant quietly dropping
            conversion webhooks — commissions stop being owed, and agents stop trusting the offers.
          </p>
        </>
      ) : (
        <p>No monitor verdict yet — the mint-vs-claim monitor has not evaluated this merchant.</p>
      )}

      <h2>Daily feed (last 14 days)</h2>
      <table cellPadding={6}>
        <thead>
          <tr><th align="left">Day</th><th align="right">Mints</th><th align="right">Claims</th><th align="right">Verified</th><th align="right">Rejected</th></tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.day.toISOString()}>
              <td>{d.day.toISOString().slice(0, 10)}</td>
              <td align="right">{d.mints}</td>
              <td align="right">{d.claims}</td>
              <td align="right">{d.verified}</td>
              <td align="right">{d.rejected}</td>
            </tr>
          ))}
          {days.length === 0 && (
            <tr><td colSpan={5}>No mint/claim activity recorded.</td></tr>
          )}
        </tbody>
      </table>
    </main>
  );
}
