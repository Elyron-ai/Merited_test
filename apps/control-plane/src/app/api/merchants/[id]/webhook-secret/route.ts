import { NextResponse, type NextRequest } from 'next/server';
import { getMerchantsService } from '../../../../../lib/platform';

/**
 * Issues a webhook secret and renders it ONCE, in this response only. The
 * plaintext is never stored retrievably (encrypted for verification via the
 * Crypter, SYN-39) and no page ever shows more than the last four characters.
 */
export const POST = async (
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> => {
  const { id } = await context.params;
  const issued = await getMerchantsService().issueWebhookSecret(id);
  const html = `<!doctype html>
<html lang="en-GB"><body style="font-family: system-ui, sans-serif; margin: 2rem auto; max-width: 48rem">
  <h1>Webhook secret issued</h1>
  <p><strong>Copy it now — it is shown exactly once and cannot be retrieved again.</strong></p>
  <p><code style="font-size: 1.2rem">${issued.secret}</code></p>
  <p>It will appear in the list as <code>…${issued.secret_last4}</code>.</p>
  <p><a href="/merchants/${id}">Back to the merchant</a></p>
</body></html>`;
  return new NextResponse(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
};
