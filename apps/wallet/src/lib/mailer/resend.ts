import { MailMessage, type Mailer } from '@merited/contracts';

/**
 * Resend mailer (PH1-7, §2.2 wire phase 1). Real HTTP against Resend's send
 * API. Dev/test stub the API key (the founder-rule posture — a real key is
 * an env change, never a code change); the `fetchImpl`/`baseUrl` seams let
 * the contract test point it at a capture server so BOTH mailers run the
 * same suite. Same `MailMessage` validation as SMTP.
 */
export interface ResendMailerOptions {
  apiKey: string;
  from: string;
  /** Defaults to Resend's real endpoint; the contract test overrides it. */
  baseUrl?: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export class ResendMailer implements Mailer {
  constructor(private readonly options: ResendMailerOptions) {}

  async send(message: { to: string; subject: string; text: string; html?: string }): Promise<void> {
    const valid = MailMessage.parse(message);
    const doFetch = this.options.fetchImpl ?? fetch;
    const response = await doFetch(`${this.options.baseUrl ?? 'https://api.resend.com'}/emails`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: this.options.from,
        to: valid.to,
        subject: valid.subject,
        text: valid.text,
        ...(valid.html ? { html: valid.html } : {}),
      }),
    });
    if (!response.ok) {
      // never echo the request body (magic-link tokens) into the error
      throw new Error(`Resend send failed: ${response.status}`);
    }
  }
}
