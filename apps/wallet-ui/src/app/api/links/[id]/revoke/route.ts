import { NextResponse, type NextRequest } from 'next/server';
import { apiBase, WALLET_COOKIE } from '../../../../../lib/api';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await context.params;
  const session = request.cookies.get(WALLET_COOKIE)?.value ?? '';
  await fetch(`${apiBase()}/v1/links/${encodeURIComponent(id)}/revoke`, {
    method: 'POST',
    headers: { cookie: `${WALLET_COOKIE}=${session}` },
  });
  return NextResponse.redirect(new URL('/accounts', request.url), 303);
}
