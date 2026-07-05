import { NextResponse, type NextRequest } from 'next/server';
import { apiBase, WALLET_COOKIE } from '../../../../../lib/api';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const form = await request.formData();
  const session = request.cookies.get(WALLET_COOKIE)?.value ?? '';
  await fetch(`${apiBase()}/v1/quotes/${encodeURIComponent(id)}/decline`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${WALLET_COOKIE}=${session}` },
    body: JSON.stringify({ mandate_id: String(form.get('mandate_id') ?? '') }),
  });
  return NextResponse.redirect(new URL('/errand', request.url), 303);
}
