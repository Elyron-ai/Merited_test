import { NextResponse, type NextRequest } from 'next/server';
import { apiBase, WALLET_COOKIE } from '../../../../lib/api';

/** Screen 2's "Link Aurora Club": start the OIDC dance at the wallet API
 * and send the BROWSER to the IdP's authorise URL. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const session = request.cookies.get(WALLET_COOKIE)?.value ?? '';
  const response = await fetch(`${apiBase()}/v1/links/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `${WALLET_COOKIE}=${session}` },
    body: JSON.stringify({
      merchant_id: String(form.get('merchant_id') ?? ''),
      programme: String(form.get('programme') ?? ''),
    }),
  });
  if (!response.ok) return NextResponse.redirect(new URL('/accounts?link_failed=1', request.url), 303);
  const { authorize_url } = (await response.json()) as { authorize_url: string };
  return NextResponse.redirect(authorize_url, 303);
}
