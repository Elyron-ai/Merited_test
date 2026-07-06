import { redirect } from 'next/navigation';
import { apiGet, pounds } from '../../../lib/api';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Approve payment' }; // W15/#36 (SC 2.4.2)

interface Requests {
  requests: Array<{
    quote_id: string;
    mandate_id: string;
    status: string;
    final_pence: number | null;
    expires_at: string | null;
  }>;
}

/** The push notification's deep-link target (PH1-17's `/approve/:quote_id`):
 * the price is locked, the clock is running, the consumer decides. Approve
 * and decline ride PH1-18's endpoints — the same ones the API tests prove. */
export default async function ApproveScreen({ params }: { params: Promise<{ quoteId: string }> }) {
  const { quoteId } = await params;
  const me = await apiGet<{ consumer_ref: string }>('/v1/me');
  if (!me) redirect('/login');
  const request = ((await apiGet<Requests>('/v1/me/approval-requests'))?.requests ?? []).find(
    (r) => r.quote_id === quoteId,
  );

  if (!request) {
    return (
      <main>
        <p><a href="/errand">← Errands</a></p>
        <h1>Nothing to approve</h1>
        <p>No approval request for this quote — it may have expired or been decided already.</p>
      </main>
    );
  }

  return (
    <main style={{ maxWidth: '28rem' }}>
      <p><a href="/errand">← Errands</a></p>
      <h1>Approve this deal?</h1>
      <p data-approve-status={request.status}>
        Your Valet locked <strong>{request.final_pence === null ? 'a price' : pounds(request.final_pence)}</strong>
        {request.expires_at ? <> — the quote holds until <code>{request.expires_at}</code></> : null}.
      </p>
      {request.status === 'pending' ? (
        <div style={{ display: 'flex', gap: '0.6rem' }}>
          <form action={`/api/quotes/${quoteId}/approve`} method="post">
            <input type="hidden" name="mandate_id" value={request.mandate_id} />
            <button type="submit">Approve</button>
          </form>
          <form action={`/api/quotes/${quoteId}/decline`} method="post">
            <input type="hidden" name="mandate_id" value={request.mandate_id} />
            <button type="submit" style={{ background: '#5a1a1a', borderColor: '#f87171' }}>
              Decline
            </button>
          </form>
        </div>
      ) : (
        <p>This request is already <strong>{request.status}</strong>.</p>
      )}
    </main>
  );
}
