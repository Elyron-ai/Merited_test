import { NextResponse, type NextRequest } from 'next/server';
import { apiBase } from '../../../../lib/api';

/** Proxy the magic-link request to the wallet API, then bounce back to the
 * login screen's "sent" state. The email never persists here. */
export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  await fetch(`${apiBase()}/v1/auth/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: String(form.get('email') ?? '') }),
  });
  return NextResponse.redirect(new URL('/login?sent=1', request.url), 303);
}
