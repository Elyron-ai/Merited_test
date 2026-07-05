import { MailMessage, type Mailer } from '@merited/contracts';
import { createTransport, type Transporter } from 'nodemailer';

/**
 * SMTP mailer (PH1-7) — the dev/test path against the compose Mailpit
 * (port 1025, no auth). Also the production SMTP fallback for programmes
 * without Resend. Validates through the shared `MailMessage` schema so it
 * refuses the same malformed input `ResendMailer` does.
 */
export interface SmtpMailerOptions {
  host: string;
  port: number;
  from: string;
  /** Mailpit needs neither TLS nor auth; real SMTP sets these. */
  secure?: boolean;
  auth?: { user: string; pass: string };
}

export class SmtpMailer implements Mailer {
  private readonly transport: Transporter;

  constructor(private readonly options: SmtpMailerOptions) {
    this.transport = createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure ?? false,
      ...(options.auth ? { auth: options.auth } : {}),
    });
  }

  async send(message: { to: string; subject: string; text: string; html?: string }): Promise<void> {
    const valid = MailMessage.parse(message);
    await this.transport.sendMail({
      from: this.options.from,
      to: valid.to,
      subject: valid.subject,
      text: valid.text,
      ...(valid.html ? { html: valid.html } : {}),
    });
  }
}
