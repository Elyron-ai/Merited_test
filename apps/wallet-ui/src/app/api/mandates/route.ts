import { NextResponse, type NextRequest } from 'next/server';
import { apiBase, WALLET_COOKIE } from '../../../lib/api';

/** Grant form → MandateGrantRequest. Whole-pound inputs become integer
 * pence with integer arithmetic — no parseFloat anywhere near money. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const wholePounds = (field: string): { amount: number; currency: 'GBP_pence' } => ({
    amount: parseInt(String(form.get(field) ?? '0'), 10) * 100,
    currency: 'GBP_pence',
  });
  const days = parseInt(String(form.get('exp_days') ?? '30'), 10);
  const categories = String(form.get('categories') ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);
  const session = request.cookies.get(WALLET_COOKIE)?.value ?? '';
  await fetch(`${apiBase()}/v1/mandates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${WALLET_COOKIE}=${session}` },
    body: JSON.stringify({
      agent_id: String(form.get('agent_id') ?? ''),
      scopes: ['offers:read', 'checkout:execute'],
      limits: { per_txn: wholePounds('per_txn_pounds'), per_month: wholePounds('per_month_pounds'), categories },
      merchants: ['*'],
      data_sharing: { email: false, purchase_history: false, loyalty_ids: true },
      pre_authorised_up_to: wholePounds('pre_auth_pounds'),
      exp: new Date(Date.now() + days * 86400 * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    }),
  });
  return NextResponse.redirect(new URL('/mandate', request.url), 303);
}
