import Link from 'next/link';
import { getPool } from '../../lib/db';
import { getMerchantsService } from '../../lib/platform';
import { ALL_REASON_CODES, explain } from '../../lib/reason-copy';

export const dynamic = 'force-dynamic';

interface ClaimRow {
  claim_id: string;
  merchant_id: string;
  gross_pence: number;
  verdict: 'pending' | 'verified' | 'rejected';
  reason_code: string | null;
  created_at: Date;
  updated_at: Date;
}

const pounds = (pence: number): string =>
  `£${Math.floor(pence / 100)}.${String(pence % 100).padStart(2, '0')}`;

export default async function Claims({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const params = await searchParams;
  const merchants = await getMerchantsService().list();
  const merchantFilter = params['merchant'] ?? '';
  const reasonFilter = params['reason'] ?? '';

  const conditions: string[] = [];
  const values: string[] = [];
  if (merchantFilter) {
    values.push(merchantFilter);
    conditions.push(`merchant_id = $${values.length}`);
  }
  if (reasonFilter) {
    values.push(reasonFilter);
    conditions.push(`reason_code = $${values.length}`);
  }
  const { rows } = await getPool().query<ClaimRow>(
    `SELECT claim_id, merchant_id, gross_pence, verdict, reason_code, created_at, updated_at
       FROM core.claims_intake
      ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
      ORDER BY created_at DESC LIMIT 200`,
    values,
  );
  const nameOf = new Map<string, string>(merchants.map((m) => [m.merchant_id, m.name]));

  return (
    <main>
      <p><Link href="/">← Dashboard</Link></p>
      <h1>Claims</h1>
      <form method="get" style={{ display: 'flex', gap: '0.75rem', alignItems: 'end' }}>
        <label>
          Merchant
          <select name="merchant" defaultValue={merchantFilter}>
            <option value="">All merchants</option>
            {merchants.map((m) => (
              <option key={m.merchant_id} value={m.merchant_id}>{m.name}</option>
            ))}
          </select>
        </label>
        <label>
          Reason code
          <select name="reason" defaultValue={reasonFilter}>
            <option value="">All outcomes</option>
            {ALL_REASON_CODES.map((code) => (
              <option key={code} value={code}>{code}</option>
            ))}
          </select>
        </label>
        <button type="submit">Filter</button>
      </form>

      <table cellPadding={6}>
        <thead>
          <tr>
            <th align="left">Claim</th><th align="left">Merchant</th><th align="left">Gross</th>
            <th align="left">Verdict</th><th align="left">Reason</th><th align="left">Received</th><th align="left">Decided</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.claim_id}>
              <td><Link href={`/claims/${row.claim_id}`}><code>{`${row.claim_id.slice(0, 14)}…`}</code></Link></td>
              <td>{nameOf.get(row.merchant_id) ?? row.merchant_id}</td>
              <td>{pounds(row.gross_pence)}</td>
              <td>{row.verdict}</td>
              <td>{row.reason_code ? <code>{row.reason_code}</code> : '—'}</td>
              <td>{row.created_at.toISOString().replace('T', ' ').slice(0, 19)}</td>
              <td>{row.updated_at.toISOString().replace('T', ' ').slice(0, 19)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {reasonFilter ? <p><em>{explain(reasonFilter)}</em></p> : null}
    </main>
  );
}
